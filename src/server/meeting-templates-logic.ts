/**
 * Reads and materialization for agenda templates.
 *
 * A `*-logic.ts` module rather than part of `meeting-templates.ts` for the two
 * independent reasons this repo already documents: a top-level db-touching
 * export inside a server-fn module drags `#/db` → `pg` → `Buffer` into the
 * client bundle, and a query living only inside a `createServerFn` handler is
 * unreachable from vitest.
 */
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { db } from "#/db";
import { db as database } from "#/db";
import {
	guests,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { generateSlotRows } from "#/lib/agenda";
import type {
	TemplateBeatRow,
	TemplateRoleRow,
} from "#/lib/agenda-template-rows";
import {
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_ROLES,
} from "#/lib/meeting-template-limits";
import { logActivity } from "./activity";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import {
	linkEvaluatorsToSpeakers,
	type MeetingSlotDefs,
} from "./meeting-create-logic";

export type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** A template as the picker shows it. */
export type MeetingTemplateSummary = {
	id: string;
	key: string;
	name: string;
	description: string | null;
	defaultLengthMinutes: number | null;
};

/**
 * Templates this club may apply: every enabled GLOBAL template (`club_id IS
 * NULL`) plus its own.
 *
 * The tenant boundary lives in the QUERY, not in a `.filter()` a later
 * refactor can drop with every test still green. Phase 1 writes no club-scoped
 * rows, but writing the predicate now means Phase 2's editor cannot leak one
 * club's template to another — the same shape #544 and #560 had to be fixed for.
 */
export async function listAvailableTemplates(
	clubId: string,
): Promise<MeetingTemplateSummary[]> {
	return database
		.select({
			id: meetingTemplates.id,
			key: meetingTemplates.key,
			name: meetingTemplates.name,
			description: meetingTemplates.description,
			defaultLengthMinutes: meetingTemplates.defaultLengthMinutes,
		})
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.enabled, true),
				// Private per-meeting copies are agendas, not choices. Excluded in
				// the QUERY rather than by a caller's `.filter()`, for the same
				// reason the tenant predicate is: a filter is droppable in a
				// refactor with every test still green.
				isNull(meetingTemplates.meetingId),
				or(
					isNull(meetingTemplates.clubId),
					eq(meetingTemplates.clubId, clubId),
				),
			),
		)
		.orderBy(asc(meetingTemplates.sortOrder), asc(meetingTemplates.name));
}

async function loadTemplateBeats(
	templateId: string,
): Promise<TemplateBeatRow[]> {
	return (
		database
			.select({
				sortOrder: meetingTemplateBeats.sortOrder,
				kind: meetingTemplateBeats.kind,
				label: meetingTemplateBeats.label,
				detail: meetingTemplateBeats.detail,
				minutes: meetingTemplateBeats.minutes,
				roleKey: meetingTemplateBeats.roleKey,
				repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
				flex: meetingTemplateBeats.flex,
				markGreen: meetingTemplateBeats.markGreen,
				markYellow: meetingTemplateBeats.markYellow,
				markRed: meetingTemplateBeats.markRed,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder))
			// The cap is enforced HERE, at the one seam every renderer reads through,
			// rather than at the (currently seed-only) writer. Ordered by sortOrder,
			// so an oversized template renders its first N beats deterministically
			// instead of blocking the event loop. Without this the constant was
			// decorative — pinned by its own test, enforced by nothing, which is the
			// exact shape CLAUDE.md's "test stated relative to the constant" trap warns about.
			.limit(MAX_TEMPLATE_BEATS)
	);
}

async function loadTemplateRoles(
	templateId: string,
): Promise<TemplateRoleRow[]> {
	return (
		database
			.select({
				key: meetingTemplateRoles.key,
				name: meetingTemplateRoles.name,
				isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId))
			.orderBy(asc(meetingTemplateRoles.sortOrder))
			// See the beats loader above — same reason, same seam.
			.limit(MAX_TEMPLATE_ROLES)
	);
}

/**
 * A template's beats and roles. Null only when the row itself does not
 * exist — which, for a `meetings.template_id` pointer, means corruption,
 * since that FK is ON DELETE RESTRICT and the template therefore cannot have
 * been deleted.
 */
export async function loadTemplateContent(
	templateId: string,
): Promise<{ beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null> {
	// THREE reads in parallel, not two. The existence check used to be inferred
	// from "both empty", which was free — but the editor can legitimately empty a
	// template, and inferring absence from emptiness turns "I deleted my last
	// row" into `meetings.ts` throwing and the meeting page going down. A third
	// parallel round trip adds no latency to `loadMeetingDetail`'s critical path,
	// which is what the old comment was protecting.
	const [beats, roles, exists] = await Promise.all([
		loadTemplateBeats(templateId),
		loadTemplateRoles(templateId),
		database
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, templateId))
			.limit(1),
	]);
	if (exists.length === 0) return null;
	return { beats, roles };
}

/**
 * The ONE definition of "which role definitions does this meeting draw slots
 * from" — the club's ENABLED standard roles when there is no template, the
 * template's materialized roles when there is.
 *
 * Exported so every reader shares one predicate instead of each spelling it
 * out. Six modules select role definitions by club, and each is choosing a slot
 * source; leaving any of them unscoped puts the contest's Chief Judge and
 * Contestants on every standard meeting created afterwards.
 *
 * SCOPE ONLY — deliberately no `enabled` filter. `slots-logic`'s readers need
 * the unfiltered set: `clubRoles` computes `speakerEnabled` by looking up the
 * picked role's flag, and `applyAddRoleSlot` distinguishes "role not found"
 * from "this role is currently disabled". Filtering here would make the first
 * silently answer for the second and flip a user-visible error message.
 * `resolveMeetingRoleDefs` applies `enabled` itself, where it belongs.
 */
export function roleDefScope(clubId: string, templateId: string | null) {
	return and(eq(roleDefinitions.clubId, clubId), roleDefScopeOnly(templateId));
}

/** The template half of `roleDefScope`, for callers that already constrain the
 *  club themselves (`listRoleDefinitions` builds an array of predicates). */
export function roleDefScopeOnly(templateId: string | null) {
	return templateId === null
		? isNull(roleDefinitions.templateId)
		: eq(roleDefinitions.templateId, templateId);
}

/**
 * Copy a template's roles into this club's `role_definitions`, tagged with the
 * template. Idempotent on `(club_id, template_id, key)` via the partial unique
 * index, and `DO NOTHING` rather than `DO UPDATE` so a club's own rename of a
 * materialized role survives every later re-application — the club's name is
 * what every surface labels with (#445), and re-materializing must not undo it.
 *
 * Copy-once is the same contract `ROLE_TEMPLATE` already has: it seeds
 * `role_definitions` at club creation and editing the constant later reaches no
 * existing club. `scripts/resync-template-roles.ts` is the deliberate escape
 * hatch for pushing a seed change to clubs that already used the template.
 *
 * Required at all because `role_slots.role_definition_id` is NOT NULL and
 * restricting: a claimable contest role has to be a real `role_definitions` row.
 */
export async function materializeTemplateRoles(
	conn: DbOrTx,
	clubId: string,
	templateId: string,
): Promise<void> {
	const roles = await conn
		.select()
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId))
		.orderBy(asc(meetingTemplateRoles.sortOrder));
	if (roles.length === 0) return;

	await conn
		.insert(roleDefinitions)
		.values(
			roles.map((r) => ({
				clubId,
				templateId,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
				description: r.description,
			})),
		)
		.onConflictDoNothing();
}

/**
 * Deep-copy a template into a PRIVATE row owned by one meeting, and return the
 * copy's id.
 *
 * This is what makes an agenda editable: the meeting points at content nobody
 * else reads, so removing a row from one contest cannot remove it from the next
 * one, and "save this shape as a template" later is a promotion (clear
 * `meeting_id`) rather than a second mechanism.
 *
 * The copy keeps the SOURCE's `key`. It is unique per meeting via
 * `meeting_templates_meeting_unique`, and the club-key index exempts private
 * rows, so the key here is provenance rather than identity — it is how you can
 * still tell what a meeting was built from after it has been edited.
 */
export async function copyTemplateForMeeting(
	conn: DbOrTx,
	input: { sourceTemplateId: string; clubId: string; meetingId: string },
): Promise<string> {
	const { sourceTemplateId, clubId, meetingId } = input;
	const [source] = await conn
		.select()
		.from(meetingTemplates)
		.where(eq(meetingTemplates.id, sourceTemplateId))
		.limit(1);
	if (!source) throw new Error("That meeting template no longer exists.");

	const [copy] = await conn
		.insert(meetingTemplates)
		.values({
			clubId,
			meetingId,
			key: source.key,
			name: source.name,
			description: source.description,
			defaultLengthMinutes: source.defaultLengthMinutes,
			sortOrder: source.sortOrder,
			enabled: source.enabled,
		})
		.returning({ id: meetingTemplates.id });
	if (!copy) throw new Error("Failed to copy the meeting template.");

	const roles = await conn
		.select()
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, sourceTemplateId));
	if (roles.length > 0) {
		await conn.insert(meetingTemplateRoles).values(
			roles.map((r) => ({
				templateId: copy.id,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
				description: r.description,
			})),
		);
	}

	const beats = await conn
		.select()
		.from(meetingTemplateBeats)
		.where(eq(meetingTemplateBeats.templateId, sourceTemplateId));
	if (beats.length > 0) {
		await conn.insert(meetingTemplateBeats).values(
			beats.map((b) => ({
				templateId: copy.id,
				sortOrder: b.sortOrder,
				kind: b.kind,
				label: b.label,
				detail: b.detail,
				minutes: b.minutes,
				roleKey: b.roleKey,
				repeatsRoleKey: b.repeatsRoleKey,
				flex: b.flex,
				markGreen: b.markGreen,
				markYellow: b.markYellow,
				markRed: b.markRed,
			})),
		);
	}

	return copy.id;
}

/**
 * PURE READ. The role definitions a meeting's slots are generated from.
 *
 * Deliberately does NOT materialize. A function named `resolve…` that quietly
 * INSERTs is a surprise for the next caller, and it made the conversion preview
 * impossible to build on: showing an officer what a change would do must not
 * itself change anything, so a preview could not call a resolver that writes
 * and would have had to duplicate this predicate. One rule, two callers.
 *
 * For a template this club has never used the result is EMPTY — the caller must
 * call `materializeTemplateRoles` first, which `applyTemplateConversion` does as
 * its own explicit step.
 */
export async function resolveMeetingRoleDefs(
	conn: DbOrTx,
	clubId: string,
	templateId: string | null,
): Promise<MeetingSlotDefs[]> {
	return conn
		.select({
			id: roleDefinitions.id,
			defaultCount: roleDefinitions.defaultCount,
			enabled: roleDefinitions.enabled,
			category: roleDefinitions.category,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			sortOrder: roleDefinitions.sortOrder,
		})
		.from(roleDefinitions)
		.where(
			templateId === null
				? // A club's `enabled` flag is its skeleton-crew switch over its OWN
					// roles. A template's roles are the contest's fixed shape, not a
					// menu — honouring the flag there would silently drop a required
					// position from the run of show.
					and(roleDefScope(clubId, null), eq(roleDefinitions.enabled, true))
				: roleDefScope(clubId, templateId),
		)
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.name));
}

// ---------------------------------------------------------------------------
// Conversion — switching a meeting's shape to (or away from) a template.
// ---------------------------------------------------------------------------

/** A member or guest whose slot the conversion released. */
export type ReleasedHolder = {
	memberId: string | null;
	guestId: string | null;
	name: string;
	roleName: string;
};

/** What a conversion will do (preview) or did (apply). */
export type ConversionPlan = {
	openSlotsRemoved: number;
	claimedSlotsReleased: number;
	slotsWithSpeeches: number;
	/** Slots the conversion will CREATE. The dialog promises this number
	 *  ("adds 17 contest roles"), and on a first-time preview it cannot come from
	 *  `role_definitions` — nothing is materialized yet, by design, because the
	 *  preview must not write. So it is read from the TEMPLATE's own rows and
	 *  reduced by whatever already exists. */
	slotsAdded: number;
	releasedHolders: ReleasedHolder[];
};

/** This meeting's slots, annotated with role name and assignee name. */
async function loadSlotsForConversion(conn: DbOrTx, meetingId: string) {
	return conn
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			roleName: roleDefinitions.name,
			assignedMemberId: roleSlots.assignedMemberId,
			assignedGuestId: roleSlots.assignedGuestId,
			memberName: members.name,
			guestName: guests.name,
			speechId: roleSlots.speechId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleSlots.roleDefinitionId, roleDefinitions.id),
		)
		.leftJoin(members, eq(roleSlots.assignedMemberId, members.id))
		.leftJoin(guests, eq(roleSlots.assignedGuestId, guests.id))
		.where(eq(roleSlots.meetingId, meetingId));
}

function summarize(
	current: Awaited<ReturnType<typeof loadSlotsForConversion>>,
	keepDefIds: Set<string>,
	targetSlotCount: number,
): ConversionPlan {
	const doomed = current.filter((s) => !keepDefIds.has(s.roleDefinitionId));
	const held = doomed.filter((s) => s.assignedMemberId || s.assignedGuestId);
	const kept = current.length - doomed.length;
	return {
		openSlotsRemoved: doomed.length - held.length,
		claimedSlotsReleased: held.length,
		slotsWithSpeeches: doomed.filter((s) => s.speechId !== null).length,
		// Never negative: a re-apply keeps every slot, so target minus kept is 0.
		slotsAdded: Math.max(0, targetSlotCount - kept),
		releasedHolders: held.map((s) => ({
			memberId: s.assignedMemberId,
			guestId: s.assignedGuestId,
			name: s.memberName ?? s.guestName ?? "Someone",
			roleName: s.roleName,
		})),
	};
}

/**
 * What applying `templateId` to this meeting WOULD do. Read-only.
 *
 * The confirmation dialog shows these counts before anything is destroyed,
 * which is the whole reason converting a meeting with live claims on it is
 * allowed at all. It reuses the SAME predicate the apply resolves through
 * (`roleDefScope`) rather than re-expressing it, so the two can never disagree
 * about what gets kept — the one thing this dialog exists to guarantee.
 */
export async function planTemplateConversion(
	meetingId: string,
	templateId: string | null,
): Promise<ConversionPlan> {
	const [meeting] = await database
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");

	const current = await loadSlotsForConversion(database, meetingId);

	// Preview must NOT materialize: a preview that writes would litter a club's
	// role_definitions with templates nobody applied.
	const target = await database
		.select({
			id: roleDefinitions.id,
			defaultCount: roleDefinitions.defaultCount,
			enabled: roleDefinitions.enabled,
		})
		.from(roleDefinitions)
		.where(roleDefScope(meeting.clubId, templateId));
	const usable = templateId === null ? target.filter((d) => d.enabled) : target;

	// How many slots the target shape has. For an ALREADY-materialized template
	// (or the club's standard roles) that is the sum over `usable`. For a
	// first-time template nothing is materialized yet, so read the template's own
	// rows instead.
	let targetSlotCount = usable.reduce((n, d) => n + d.defaultCount, 0);
	if (templateId !== null && usable.length === 0) {
		const rows = await database
			.select({ defaultCount: meetingTemplateRoles.defaultCount })
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId));
		targetSlotCount = rows.reduce((n, r) => n + r.defaultCount, 0);
	}

	return summarize(current, new Set(usable.map((r) => r.id)), targetSlotCount);
}

/**
 * Apply a template to an existing meeting, or `null` to convert it back to the
 * club's standard shape. ONE transaction.
 *
 * Released holders are RETURNED, never enqueued on `notifications`:
 * `notifications.slot_id` is NOT NULL and ON DELETE CASCADE to `role_slots`, so
 * a row enqueued against a slot this transaction then deletes is cascade-deleted
 * before the poller could ever see it — a notification that silently never
 * sends. The caller surfaces the existing WhatsApp nudge against each name.
 *
 * Authorization is the CALLER's: this function has no session. The server fn
 * gates on the club role and the archive state before calling it.
 */
export async function applyTemplateConversion(input: {
	meetingId: string;
	clubId: string;
	templateId: string | null;
	actorMemberId: string | null;
}): Promise<ConversionPlan> {
	const { meetingId, clubId, templateId, actorMemberId } = input;

	if (templateId !== null) {
		const content = await loadTemplateContent(templateId);
		if (!content) throw new Error("That meeting template no longer exists.");
	}

	return database.transaction(async (tx) => {
		const [meeting] = await tx
			.select({
				id: meetings.id,
				status: meetings.status,
				clubId: meetings.clubId,
				templateId: meetings.templateId,
			})
			.from(meetings)
			.where(eq(meetings.id, meetingId))
			.limit(1);
		if (!meeting || meeting.clubId !== clubId) {
			throw new Error("Meeting not found.");
		}
		// The canonical lock (#150 / ADR-0012) covers `completed`. A CANCELLED
		// meeting is not locked by it, but reshaping one is equally pointless, so
		// it is refused here rather than by widening the shared helper — every
		// other mutator's meaning of "locked" stays exactly as it was.
		assertMeetingNotLocked(meeting.status);
		if (meeting.status === "cancelled") {
			throw new Error("A cancelled meeting cannot change its template.");
		}

		// The meeting's CURRENT private template, if it has one — captured before
		// we repoint, because that is what we must retire afterwards.
		const previousPrivateId = meeting.templateId
			? ((
					await tx
						.select({ id: meetingTemplates.id })
						.from(meetingTemplates)
						.where(
							and(
								eq(meetingTemplates.id, meeting.templateId),
								eq(meetingTemplates.meetingId, meetingId),
							),
						)
						.limit(1)
				)[0]?.id ?? null)
			: null;

		// Detach (never delete-in-place) the outgoing private copy FIRST.
		// `meeting_templates_meeting_unique` is a bare unique INDEX, not a
		// deferrable constraint, so it is enforced the instant
		// `copyTemplateForMeeting`'s INSERT runs below — the old row's own
		// `meeting_id` has to be cleared before that insert, not after.
		// (Nulling `meetings.template_id` would not do this: that column and
		// `meeting_templates.meeting_id` are different columns on different
		// tables.) The row can't be fully DELETEd yet either:
		// `role_definitions.template_id` is ON DELETE RESTRICT and still points
		// at it — materialized when this very copy was made — and those
		// `role_definitions` rows can't go until the `role_slots` referencing
		// them are reconciled below, which needs the NEW template's defs, which
		// don't exist until the copy is inserted. So: detach now, retire in full
		// once the new shape is in place.
		if (previousPrivateId !== null) {
			await tx
				.update(meetingTemplates)
				.set({ meetingId: null })
				.where(eq(meetingTemplates.id, previousPrivateId));
		}

		// Deep-copy so this meeting's agenda is its own. Re-converting makes a
		// FRESH copy, which is what keeps an edited contest from leaking into the
		// next one.
		const effectiveTemplateId =
			templateId === null
				? null
				: await copyTemplateForMeeting(tx, {
						sourceTemplateId: templateId,
						clubId,
						meetingId,
					});

		// Materialize EXPLICITLY, as its own step. `resolveMeetingRoleDefs` is a
		// pure read, so the write has to be visible here rather than hidden inside
		// a function named `resolve…`. Idempotent.
		if (effectiveTemplateId !== null) {
			await materializeTemplateRoles(tx, clubId, effectiveTemplateId);
		}
		const defs = await resolveMeetingRoleDefs(tx, clubId, effectiveTemplateId);
		const keepDefIds = new Set(defs.map((d) => d.id));
		const current = await loadSlotsForConversion(tx, meetingId);
		const plan = summarize(
			current,
			keepDefIds,
			defs.reduce((n, d) => n + d.defaultCount, 0),
		);

		const doomedIds = current
			.filter((s) => !keepDefIds.has(s.roleDefinitionId))
			.map((s) => s.id);
		if (doomedIds.length > 0) {
			// Release first, then delete. Clearing the assignee and the speech
			// pointer in their own statement keeps "a slot is released before it
			// disappears" true at every intermediate state. The speech itself is
			// Person-owned (ADR-0009), so it survives regardless.
			await tx
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					assignedGuestId: null,
					speechId: null,
					status: "open",
					claimedAt: null,
				})
				.where(inArray(roleSlots.id, doomedIds));
			await tx.delete(roleSlots).where(inArray(roleSlots.id, doomedIds));
		}

		const existingDefIds = new Set(
			current
				.filter((s) => keepDefIds.has(s.roleDefinitionId))
				.map((s) => s.roleDefinitionId),
		);
		const toCreate = defs.filter((d) => !existingDefIds.has(d.id));
		if (toCreate.length > 0) {
			const rows = generateSlotRows(toCreate, meetingId);
			if (rows.length > 0) {
				const inserted = await tx.insert(roleSlots).values(rows).returning({
					id: roleSlots.id,
					roleDefinitionId: roleSlots.roleDefinitionId,
					slotIndex: roleSlots.slotIndex,
				});
				await linkEvaluatorsToSpeakers(tx, inserted, defs);
			}
		}

		const length =
			effectiveTemplateId === null
				? null
				: ((
						await tx
							.select({ m: meetingTemplates.defaultLengthMinutes })
							.from(meetingTemplates)
							.where(eq(meetingTemplates.id, effectiveTemplateId))
							.limit(1)
					)[0]?.m ?? null);

		await tx
			.update(meetings)
			.set({
				templateId: effectiveTemplateId,
				...(length != null ? { lengthMinutes: length } : {}),
			})
			.where(eq(meetings.id, meetingId));

		// Retire the superseded private copy now, not earlier: `meetings.template_id`
		// no longer references it (just updated above, satisfying its own RESTRICT),
		// and every role_slot that used to reference its materialized
		// role_definitions was just reconciled away (doomedIds, above) — ALL of
		// them, since a private copy's role_definitions carry a fresh template_id
		// every time and can never overlap with `effectiveTemplateId`'s.
		// role_definitions has to go first: it is ALSO ON DELETE RESTRICT against
		// meeting_templates, independently of the meetings.template_id one above.
		if (previousPrivateId !== null) {
			await tx
				.delete(roleDefinitions)
				.where(roleDefScope(clubId, previousPrivateId));
			await tx
				.delete(meetingTemplates)
				.where(eq(meetingTemplates.id, previousPrivateId));
		}

		await logActivity(tx, {
			clubId,
			actorMemberId,
			action: "meeting_template_set",
			targetType: "meeting",
			targetId: meetingId,
			detail: { templateId, privateTemplateId: effectiveTemplateId },
		});

		return plan;
	});
}

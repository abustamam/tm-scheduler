/**
 * Per-meeting agenda editing (configurable agendas, Phase 2).
 *
 * A templated meeting owns a PRIVATE `meeting_templates` row (`meeting_id` non
 * null, created by `copyTemplateForMeeting`), so editing an agenda is editing
 * that copy and reaches no other meeting.
 *
 * A `*-logic.ts` module for the two reasons this repo documents: a top-level
 * db-touching export in a server-fn module drags `#/db` → `pg` → `Buffer` into
 * the client bundle, and a query living only inside a `createServerFn` handler
 * is unreachable from vitest — which for a module of gates is the whole ball
 * game.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db as database } from "#/db";
import {
	clubs,
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
import { materialiseRunOfShow } from "#/lib/agenda-materialise";
import type { AgendaSlot } from "#/lib/agenda-runsheet";
import {
	isMeetingLocked,
	MEETING_LOCKED_MESSAGE,
} from "#/lib/meeting-lifecycle";
import {
	MAX_BEAT_MINUTES,
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
	MAX_TEMPLATE_ROLES,
} from "#/lib/meeting-template-limits";
import { matchRoleDefs } from "#/lib/role-def-match";
import { logActivity } from "./activity";
import { loadMeetingSlots } from "./meeting-slots-logic";
import {
	copyTemplateForMeeting,
	type DbOrTx,
	materializeTemplateRoles,
	type ReleasedHolder,
	roleDefScope,
} from "./meeting-templates-logic";

export type { ReleasedHolder };

export type AgendaDraftRow = {
	id: string;
	sortOrder: number;
	kind: "section" | "role" | "event";
	label: string;
	detail: string | null;
	minutes: number;
	roleKey: string | null;
	repeatsRoleKey: string | null;
	/**
	 * Whether this row stretches to fill the slot.
	 *
	 * Required for CORRECTNESS, not only for the editor's pin control:
	 * `buildTemplateRows` reads `row.flex` to mark the row `applyFlex` resizes,
	 * and the editor runs that same pipeline in the browser. Omit it here and
	 * the client's `applyFlex` finds an empty `flexIndices` on every meeting
	 * forever — a permanent no-op whose only symptom is the editor's clock
	 * quietly disagreeing with the printed agenda. It fails in the direction
	 * that looks fine.
	 */
	flex: boolean;
	handoff: boolean;
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
};

export type AgendaDraftRole = {
	key: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	isSpeakerRole: boolean;
};

export type AgendaDraft = {
	templateId: string;
	templateName: string;
	/** False once the meeting is locked. The rows still load — an agenda is
	 *  worth reading after the night, it just stops being writable. */
	editable: boolean;
	rows: AgendaDraftRow[];
	roles: AgendaDraftRole[];
	/**
	 * Everything below exists so the CLIENT can compute the running clock, by
	 * calling the same three pure functions the print route calls
	 * (`resolveAgendaRows` → `applyFlex` → `buildTimeline`) rather than a second
	 * derivation of its own. A parity test cannot see a defect present on both
	 * sides, so the fix is to have only one side.
	 */
	/** This meeting's role slots — what a repeat block fans across, and where
	 *  the Who column's names come from. */
	slots: AgendaSlot[];
	/** ISO instant. `buildTimeline` accepts `Date | string`, and this crosses a
	 *  server-fn boundary where a Date does not survive. */
	scheduledAt: string;
	timeZone: string;
	/** The booking to measure the agenda against. */
	lengthMinutes: number;
	/** Ignored on the template branch; `resolveAgendaRows` requires it, and the
	 *  standard branch is where it starts mattering. */
	geIntroducesFunctionaries: boolean;
};

/**
 * Whether a meeting's agenda may currently be edited: not locked (completed)
 * and not cancelled. Shared by `loadAgendaDraft` (what `editable` reports) and
 * `ensureAgendaDraft` (what a write actually allows) so the two cannot drift.
 * They did, briefly: `editable` was `!isMeetingLocked` alone, so a cancelled
 * meeting rendered a fully interactive editor whose every save threw.
 */
function agendaEditable(status: string): boolean {
	return !isMeetingLocked(status) && status !== "cancelled";
}

/**
 * This meeting's editable agenda, or null when it has none.
 *
 * Null means STANDARD: a meeting with `template_id IS NULL` renders the
 * code-derived `RUN_OF_SHOW`, which this editor deliberately does not touch.
 *
 * `meeting.templateId` is read here WITHOUT requiring it to be the meeting's
 * own private copy (`meeting_templates.meeting_id = meetingId`). A meeting
 * converted before this feature landed points straight at a SHARED template
 * instead — Task 6 returned null for that case on the theory that
 * `ensureAgendaDraft` would upgrade it on first write, but that is circular:
 * the route redirects away on null, so the officer never reaches a write, and
 * the upgrade that only fires on write never fires either — for every such
 * meeting, which in production is all of them. Reading it directly is safe
 * either way: `meeting.templateId` is not caller-supplied, it is the meeting's
 * OWN pointer, and the content is exactly what the meeting page already
 * renders. `ensureAgendaDraft` still forks a private copy, just on the first
 * WRITE rather than the first read.
 */
/**
 * Build this meeting its own editable copy of the standard agenda, once.
 *
 * In a TRANSACTION with a re-read under `FOR UPDATE`: two officers opening the
 * editor in the same second would otherwise both see a null `template_id` and
 * mint two private templates, and the loser's rows become orphans no surface
 * ever shows.
 *
 * No `role_definitions` are materialised, unlike a contest conversion. The
 * standard flow binds its beats to the club's EXISTING roles by key, so private
 * copies would detach this meeting's slots from the club roster — the opposite
 * of what an ordinary meeting wants.
 */
async function materialiseForMeeting(
	meetingId: string,
	clubId: string,
	geIntroducesFunctionaries: boolean,
): Promise<string> {
	return await database.transaction(async (tx) => {
		const [locked] = await tx
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId))
			.for("update")
			.limit(1);
		if (locked?.templateId) return locked.templateId;

		const seeds = materialiseRunOfShow(geIntroducesFunctionaries);
		const [tpl] = await tx
			.insert(meetingTemplates)
			.values({
				clubId,
				meetingId,
				key: `meeting-${meetingId}`,
				name: "Standard meeting",
			})
			.returning({ id: meetingTemplates.id });
		if (!tpl) throw new Error("Failed to create the agenda copy.");

		await tx
			.insert(meetingTemplateBeats)
			.values(seeds.map((seed) => ({ ...seed, templateId: tpl.id })));
		await tx
			.update(meetings)
			.set({ templateId: tpl.id })
			.where(eq(meetings.id, meetingId));
		return tpl.id;
	});
}

export async function loadAgendaDraft(
	meetingId: string,
): Promise<AgendaDraft | null> {
	const [meeting] = await database
		.select({
			templateId: meetings.templateId,
			clubId: meetings.clubId,
			status: meetings.status,
			scheduledAt: meetings.scheduledAt,
			lengthMinutes: meetings.lengthMinutes,
			// Joined rather than fetched separately: the client needs all four to
			// run the same clock pipeline the print route runs, and a second
			// round-trip for two scalars is waste.
			timeZone: clubs.timezone,
			geIntroducesFunctionaries: clubs.geIntroducesFunctionaries,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) return null;
	// An ordinary meeting has no template until someone edits it. Building the
	// copy HERE rather than refusing is what makes the whole calendar editable —
	// before #622 this returned null and the route redirected away, so the
	// agenda editor reached only the meetings someone had converted.
	const templateId =
		meeting.templateId ??
		(await materialiseForMeeting(
			meetingId,
			meeting.clubId,
			meeting.geIntroducesFunctionaries,
		));

	const [tpl] = await database
		.select({ id: meetingTemplates.id, name: meetingTemplates.name })
		.from(meetingTemplates)
		.where(eq(meetingTemplates.id, templateId))
		.limit(1);
	// Only reachable if the pointer is corrupt: `meetings.template_id` is ON
	// DELETE RESTRICT against `meeting_templates`, so the row a live pointer
	// names cannot have been deleted.
	if (!tpl) return null;

	const [rows, roles, slots] = await Promise.all([
		database
			.select({
				id: meetingTemplateBeats.id,
				sortOrder: meetingTemplateBeats.sortOrder,
				kind: meetingTemplateBeats.kind,
				label: meetingTemplateBeats.label,
				detail: meetingTemplateBeats.detail,
				minutes: meetingTemplateBeats.minutes,
				roleKey: meetingTemplateBeats.roleKey,
				repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
				// See `AgendaDraftRow.flex` — load-bearing for the client's
				// `applyFlex`, not just for the editor's pin control.
				flex: meetingTemplateBeats.flex,
				handoff: meetingTemplateBeats.handoff,
				markGreen: meetingTemplateBeats.markGreen,
				markYellow: meetingTemplateBeats.markYellow,
				markRed: meetingTemplateBeats.markRed,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, tpl.id))
			.orderBy(asc(meetingTemplateBeats.sortOrder)),
		database
			.select({
				key: meetingTemplateRoles.key,
				name: meetingTemplateRoles.name,
				category: meetingTemplateRoles.category,
				defaultCount: meetingTemplateRoles.defaultCount,
				isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, tpl.id))
			.orderBy(asc(meetingTemplateRoles.sortOrder)),
		// The SAME loader the meeting page and the print route use, so the
		// editor's clock cannot disagree with theirs about what a slot is.
		loadMeetingSlots(meetingId),
	]);

	return {
		templateId: tpl.id,
		templateName: tpl.name,
		editable: agendaEditable(meeting.status),
		slots,
		scheduledAt: meeting.scheduledAt.toISOString(),
		timeZone: meeting.timeZone,
		lengthMinutes: meeting.lengthMinutes,
		geIntroducesFunctionaries: meeting.geIntroducesFunctionaries,
		rows,
		roles,
	};
}

// ---------------------------------------------------------------------------
// Writes — every mutator below is scoped to the CALLING meeting's own private
// template. The row id is caller-supplied, so without that scoping an officer
// of one club could edit another club's agenda by naming its row id.
// ---------------------------------------------------------------------------

/** What an officer reads when a fork lost a race the lock could not cover —
 *  a sentence, never the driver's `Failed query: insert into …`. */
const AGENDA_CONCURRENT_EDIT_MESSAGE =
	"Another change to this agenda was saved at the same moment. Reload and try again.";

/**
 * What an officer reads when Postgres broke a lock cycle by killing this
 * transaction — again a sentence, never `deadlock detected`.
 *
 * Reachable because `ensureAgendaDraft` and `applyTemplateConversion` take the
 * same two resources in OPPOSITE orders on one meeting: this function takes
 * `meetings FOR UPDATE` first and re-points that meeting's `role_slots` late,
 * while a conversion writes `role_slots` first and updates `meetings` last.
 * A conversion and a first agenda edit in flight together therefore deadlock,
 * and 40P01 is not a unique violation, so without this the driver's own
 * message reached the toast.
 *
 * Note it is `role_slots` that cycles, NOT `meeting_templates`, even though
 * that is the pair the two lock orders appear to fight over.
 * `meeting_templates.meeting_id` is a foreign key, so inserting a private copy
 * takes `FOR KEY SHARE` on the referenced `meetings` row — which conflicts
 * with the `FOR UPDATE` above and serializes those two orderings completely,
 * with no cycle available. The conversion arm that reaches `role_slots`
 * holding nothing on `meetings` is the one that REMOVES a template
 * (`templateId === null`), which inserts no copy and so takes no key share.
 * `meeting-agenda-edit-logic.integration.test.ts` builds exactly that cycle.
 *
 * No automatic retry: the loser's transaction is already rolled back, and a
 * silent retry would re-run a write the officer has no way to know happened
 * twice. Asking is honest and the case is rare.
 */
const AGENDA_DEADLOCK_MESSAGE =
	"Someone else was changing this meeting. Please try again.";

/** SQLSTATE `code`, wherever the driver hung it: drizzle wraps a `pg` error as
 *  the `cause` of its own, and a bare `pg` error carries `code` itself. */
function isSqlState(err: unknown, code: string): boolean {
	const direct = (err as { code?: unknown } | null)?.code;
	const wrapped = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
	return direct === code || wrapped === code;
}

/** SQLSTATE 23505 — a unique index rejected an insert. */
function isUniqueViolation(err: unknown): boolean {
	return isSqlState(err, "23505");
}

/** SQLSTATE 40P01 — Postgres chose this transaction as a deadlock victim. */
function isDeadlock(err: unknown): boolean {
	return isSqlState(err, "40P01");
}

/** What `ensureAgendaDraft` resolved: the meeting's own private template id,
 *  and whether this call is the one that just forked it. */
export type AgendaDraftHandle = {
	templateId: string;
	/** True only on the call that performed the copy.
	 *
	 *  RETAINED FOR TESTS — no production caller reads it. Deciding how to
	 *  re-locate a caller-supplied row is `found.templateId !== templateId`
	 *  instead, because the row ids can be stale from a fork some OTHER call
	 *  performed — this flag is false in exactly that case and the translation
	 *  was skipped, which is how the loser of a concurrent first write ended up
	 *  filtering a shared template's row id against a private copy and matching
	 *  nothing.
	 *
	 *  Its one reader is the residual-race test in
	 *  `meeting-agenda-edit-logic.integration.test.ts` ("adopts the existing
	 *  copy instead of surfacing a unique violation"), where it is the direct
	 *  evidence that the catch ADOPTED the racer's copy rather than writing a
	 *  second one — a thing the returned `templateId` alone cannot say. Delete
	 *  it and that assertion has to be rebuilt out of row counts. */
	forked: boolean;
};

/**
 * The meeting's own private template id, or a thrown error. Reports whether
 * it just forked one (see `AgendaDraftHandle`) — Task 8 also calls this, so
 * its signature is `Promise<AgendaDraftHandle>`, not the bare `Promise<string>`
 * the brief specified; a bare string had no way to tell a caller which
 * matching strategy is safe (see the mutators below and finding #3 in the
 * task-7 fix-round report).
 *
 * Upgrades on first write: a meeting converted before this feature points at a
 * SHARED template, and editing that would rewrite the agenda for every club
 * using it. Rather than refuse, the first edit copies it — the officer's
 * intent is to change THIS meeting, and the copy is exactly what makes that
 * true. (This is also what `loadAgendaDraft`'s docblock refers to as the
 * upgrade happening on WRITE rather than on read.)
 *
 * MUST be called inside a transaction. It may call `copyTemplateForMeeting`,
 * which is itself multi-statement and NOT self-transactional (its own
 * docblock says so explicitly) — calling this outside a transaction risks a
 * mid-copy failure leaving a template row with partial roles and beats while
 * `meetings.template_id` already points at it. Every caller in this module
 * runs it inside `database.transaction`; a new caller should too.
 *
 * The `meetings` row is taken `FOR UPDATE` before anything else, and that is
 * the whole of the concurrency story: without it, two writes landing together
 * on an unforked meeting BOTH found no private copy and both inserted one, and
 * `meeting_templates_meeting_unique` rejected the second with the driver's own
 * `Failed query: insert into "meeting_templates" (…)` — which `runAction`
 * toasts verbatim at the officer. It needs no crafted request: the editor's
 * text inputs stay enabled while a save is in flight, so blurring Label and
 * changing Minutes fires two concurrent POSTs. With the lock, the loser blocks
 * until the winner commits and then simply FINDS the copy, taking the
 * `own` early return.
 *
 * The catch below is the residual, and it is reachable: this function takes
 * `conn`, and a caller passing the bare `db` rather than a transaction holds
 * the row lock only for the length of that one statement. It re-resolves
 * rather than rethrowing, because by definition the row it failed to insert
 * now exists and is the answer. `copyTemplateForMeeting` runs inside a nested
 * transaction (a SAVEPOINT when `conn` is already one) so a rejected insert
 * does not poison the caller's transaction on the way back out.
 *
 * The OTHER concurrency failure the lock introduced is a deadlock, and it is
 * translated by the wrapper rather than handled here — see
 * `AGENDA_DEADLOCK_MESSAGE`. Wrapped around the WHOLE body, not bolted onto
 * the unique-violation catch below, because 40P01 can be raised by ANY
 * statement that waits — the `FOR UPDATE` at the top, the `meeting_templates`
 * insert in the middle and the `role_slots` re-point near the end are all lock
 * waits, and only the last of them is where the conversion cycle is known to
 * land. Catching at one of them would be catching the case we happened to
 * find.
 */
export async function ensureAgendaDraft(
	conn: DbOrTx,
	meetingId: string,
): Promise<AgendaDraftHandle> {
	try {
		return await resolveAgendaDraft(conn, meetingId);
	} catch (err) {
		if (!isDeadlock(err)) throw err;
		throw new Error(AGENDA_DEADLOCK_MESSAGE);
	}
}

/** `ensureAgendaDraft`'s body — see its docblock for all of it. Split out only
 *  so the deadlock translation can wrap every statement below at once. */
async function resolveAgendaDraft(
	conn: DbOrTx,
	meetingId: string,
): Promise<AgendaDraftHandle> {
	const [meeting] = await conn
		.select({
			templateId: meetings.templateId,
			clubId: meetings.clubId,
			status: meetings.status,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		// Before the private-copy lookup below, not after: the lookup is the
		// read this serializes.
		.for("update")
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");
	if (!meeting.templateId) {
		throw new Error(
			"Only a meeting with a meeting type can have its agenda edited.",
		);
	}
	// Same predicate `loadAgendaDraft` reports as `editable` — see
	// `agendaEditable`'s docblock for why these two must share one definition.
	if (!agendaEditable(meeting.status)) {
		throw new Error(
			isMeetingLocked(meeting.status)
				? MEETING_LOCKED_MESSAGE
				: "A cancelled meeting's agenda cannot be edited.",
		);
	}

	const [own] = await conn
		.select({ id: meetingTemplates.id })
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.id, meeting.templateId),
				eq(meetingTemplates.meetingId, meetingId),
			),
		)
		.limit(1);
	if (own) return { templateId: own.id, forked: false };

	let copyId: string;
	try {
		copyId = await conn.transaction((fork) =>
			copyTemplateForMeeting(fork, {
				sourceTemplateId: meeting.templateId as string,
				clubId: meeting.clubId,
				meetingId,
			}),
		);
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		// The only unique index `copyTemplateForMeeting`'s INSERT can trip is
		// `meeting_templates_meeting_unique` — the other two are partial on
		// `club_id IS NULL` and `meeting_id IS NULL`, and this row has neither.
		// So the violation IS "someone else forked first", and their copy is
		// the answer this call was looking for.
		const [raced] = await conn
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.meetingId, meetingId))
			.limit(1);
		if (!raced) throw new Error(AGENDA_CONCURRENT_EDIT_MESSAGE);
		return { templateId: raced.id, forked: false };
	}

	// `copyTemplateForMeeting` only copies the `meeting_template_roles`
	// DECLARATIONS, not the materialized `role_definitions` every
	// `roleDefScope` reader — including the "+ Add role" picker
	// (`meetings.ts`) — actually queries. Without this, a meeting just
	// forked off a SHARED template points `templateId` at a template with NO
	// role_definitions at all, and the picker comes back empty (task-8b).
	// Idempotent, and a no-op cost when the source declared no roles.
	await materializeTemplateRoles(conn, meeting.clubId, copyId);

	// Re-point THIS MEETING's own slots from the OLD (still-shared)
	// definitions to the freshly materialized ones, matched through
	// `matchRoleDefs` — the shared key-then-name rule, which
	// `applyTemplateConversion` now runs too so a conversion and a first edit
	// keep exactly the same slots. See that helper's own docblock for why the
	// either/or is strict.
	//
	// Do NOT move the OLD definitions by updating their own `templateId`:
	// `role_definitions` is keyed per (club, template), not per meeting, so a
	// SIBLING meeting still on the shared template may still reference them
	// — only this meeting's own `role_slots` rows are touched, by exact
	// `meetingId` + old `roleDefinitionId`, never the definitions themselves.
	const oldDefs = await conn
		.select({
			id: roleDefinitions.id,
			key: roleDefinitions.key,
			name: roleDefinitions.name,
		})
		.from(roleDefinitions)
		.where(roleDefScope(meeting.clubId, meeting.templateId));
	if (oldDefs.length > 0) {
		const newDefs = await conn
			.select({
				id: roleDefinitions.id,
				key: roleDefinitions.key,
				name: roleDefinitions.name,
			})
			.from(roleDefinitions)
			.where(roleDefScope(meeting.clubId, copyId));

		// Unmatched definitions are simply absent from the map — a keyed role
		// the template no longer declares, or an unkeyed one with no (or an
		// ambiguous) name match: those slots stay pointing at the old, still
		// valid definition rather than the fork inventing a delete/orphan
		// behavior here, which is `removeAgendaRole`'s job.
		for (const [oldDefId, def] of matchRoleDefs(oldDefs, newDefs)) {
			await conn
				.update(roleSlots)
				.set({ roleDefinitionId: def.id })
				.where(
					and(
						eq(roleSlots.meetingId, meetingId),
						eq(roleSlots.roleDefinitionId, oldDefId),
					),
				);
		}
	}

	await conn
		.update(meetings)
		.set({ templateId: copyId })
		.where(eq(meetings.id, meetingId));
	return { templateId: copyId, forked: true };
}

/** Cap by CODE POINTS, not UTF-16 units — see `capChars` in
 *  `agenda-template-rows.ts`. Slicing a surrogate pair in half yields a lone
 *  surrogate that renders as a replacement glyph and makes
 *  `encodeURIComponent` throw for any consumer building a URL from it (#522).
 *  Enforced here too, at the writer, so an officer cannot build a template the
 *  renderer's own cap would then silently truncate. */
function assertWithin(value: string, max: number, what: string): void {
	// Decided from `.length` BEFORE spreading, in both directions. The spread
	// allocates an array one element per code point, so doing it first means the
	// whole input is materialized before anything decides it was too long — the
	// #519 shape verbatim, on a value the zod layer bounds only loosely.
	//
	// UTF-16 length brackets the code-point count from both sides:
	// `codePoints <= value.length <= 2 * codePoints`, since only a surrogate PAIR
	// costs two units. So `value.length <= max` is certainly within, and
	// `value.length > max * 2` is certainly over. Only the band between them is
	// genuinely ambiguous, and it is bounded by `2 * max` — a few hundred code
	// points here — which is what makes the spread affordable.
	if (value.length <= max) return;
	if (value.length > max * 2 || [...value].length > max) {
		throw new Error(`That ${what} is too long (max ${max} characters).`);
	}
}

type MarkFields = {
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
};

/**
 * All three marks or none, checked against the MERGED result — the row as it
 * will read AFTER this patch applies — not the patch in isolation.
 * `resolveMarks` (agenda-template-rows.ts) treats all-three-or-none as the
 * contract and drops a partial set silently; a timer card with a hole in it
 * is worse than no card, so the writer refuses rather than the renderer
 * discarding.
 *
 * Checking the patch alone is wrong in BOTH directions. `{markGreen: null}`
 * against a row already holding (2,3,4) touches one key with value null —
 * zero "set" values in the patch alone, which a patch-only check waves
 * through as "none" — but the row ends up (null,3,4), the exact silent hole
 * this function exists to refuse. Symmetrically, `{markGreen:2,
 * markYellow:3}` against a row already holding `markRed:4` touches two keys
 * both non-null — a patch-only check refuses it as "partial" — but the
 * MERGED result is complete and should be accepted.
 */
function assertMarks(current: MarkFields, patch: Partial<MarkFields>): void {
	const keys = ["markGreen", "markYellow", "markRed"] as const;
	const merged = keys.map((k) =>
		k in patch ? (patch[k] ?? null) : current[k],
	);
	const set = merged.filter((v) => v != null).length;
	if (set !== 0 && set !== 3) {
		throw new Error("Timing marks need all three values, or none.");
	}
}

/** The two role bindings a beat can carry, plus the `kind` that decides which
 *  combinations of them are legal. */
type RoleBinding = {
	kind: "section" | "role" | "event";
	roleKey: string | null;
	repeatsRoleKey: string | null;
};

/**
 * D4's once/per-holder rule, enforced against the MERGED row.
 *
 * `repeats_role_key` IS the once/per-holder flag — there is no separate
 * column. A row is "once" when its own `repeats_role_key` is null, and "per
 * holder" when it carries its OWN key. The spec (D4), `CONTEXT.md` and
 * `TODOS.md` all record "a role row whose own role differs from its repeat
 * key" as UNAUTHORABLE; until this function existed, all three said so and
 * nothing enforced it.
 *
 * Merged, not patch-in-isolation, for the same reason `assertMarks` is: the
 * reachable route is TWO legal patches. Tick "one row per person"
 * (`{repeatsRoleKey: X}` on a row already naming X), then change the Role
 * select (`{roleKey: Y}` alone). Neither patch is wrong by itself; the row
 * they compose is, and a patch-only check waves both through.
 *
 * What the illegal row does: `buildTemplateRows` forms a repeat block on X,
 * `blockRow.roleKey === repeatKey` is false so `bound` is empty, and the row
 * prints once per holder of X, NUMBERED and naming nobody — on a contest run
 * sheet. Meanwhile the editor's own `perHolder` computes false and the label
 * reads "One row", so the editor lies about the row's state. And
 * `removeAgendaRole` deletes beats on `roleKey = X OR repeatsRoleKey = X`, so
 * removing X would silently take a row now bound to Y with it.
 *
 * The one shape that looks like a violation and is NOT: a NON-role row inside
 * a repeat block — the seeded contest's "One minute of silence" carries
 * `repeatsRoleKey: "contestant_prepared"` with no `roleKey` of its own, and
 * `buildTemplateRows` handles it deliberately (`bound = []`, repeats as-is).
 * That is why this is keyed on `kind` rather than simply requiring the two
 * keys to match whenever either is set: forbidding it would make the shipped
 * contest template unwritable. A `role` row with no `roleKey` is a different
 * thing — `toRow` returns null for it, so it renders NOWHERE while still
 * showing in the editor, and once the Role is "Nobody" the per-holder
 * checkbox is hidden and no UI path can clear the leftover key.
 */
function assertRepeatBinding(
	current: RoleBinding,
	patch: { roleKey?: string | null; repeatsRoleKey?: string | null },
): void {
	const roleKey =
		"roleKey" in patch ? (patch.roleKey ?? null) : current.roleKey;
	const repeatsRoleKey =
		"repeatsRoleKey" in patch
			? (patch.repeatsRoleKey ?? null)
			: current.repeatsRoleKey;
	if (repeatsRoleKey === null) return;
	if (current.kind !== "role" && roleKey === null) return;
	if (repeatsRoleKey !== roleKey) {
		throw new Error(
			"A row that repeats per holder must repeat over the same role it names.",
		);
	}
}

/**
 * `roleKey` / `repeatsRoleKey` must name a role this template actually
 * declares, or be left null. `agenda-template-rows.ts`'s `toRow` documents
 * the read-side consequence of skipping this check: "A beat naming a role the
 * template does not declare is dropped rather than rendered against an
 * invented name... Phase 2's editor needs a validation error." Without this,
 * setting a role beat's `roleKey` to an undeclared value doesn't error at
 * all — it makes the beat silently vanish from the printed agenda, the
 * projected deck and the `.pptx`.
 *
 * Checked against the template's declared keys inside the SAME transaction,
 * after `ensureAgendaDraft` resolves the FINAL templateId — a fork copies
 * `meeting_template_roles` too, so the declared set is fresh for whichever
 * template (shared source or new private copy) the row is about to belong to.
 */
async function assertDeclaredRoleKeys(
	conn: DbOrTx,
	templateId: string,
	patch: { roleKey?: string | null; repeatsRoleKey?: string | null },
): Promise<void> {
	const named = [patch.roleKey, patch.repeatsRoleKey].filter(
		(k): k is string => k != null,
	);
	if (named.length === 0) return;
	const declared = await conn
		.select({ key: meetingTemplateRoles.key })
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId));
	const declaredKeys = new Set(declared.map((d) => d.key));
	for (const key of named) {
		if (!declaredKeys.has(key)) {
			throw new Error(`"${key}" is not a role this template declares.`);
		}
	}
}

/**
 * Move every id in `pairs` to its paired `sortOrder`, in ONE statement via a
 * simple `CASE id WHEN … THEN … END`, scoped to `templateId`.
 *
 * Both value positions are cast explicitly (`::uuid`, `::integer`, and the
 * CASE expression itself once more). Postgres cannot always infer a bound
 * parameter's type from a `CASE` branch alone — measured directly: the
 * uncast version above threw `column "sort_order" is of type integer but
 * expression is of type text` the first time this ran against real Postgres,
 * because with no other hint it defaulted every parameter's type to `text`.
 * The casts are load-bearing, not decoration.
 */
async function bulkSetSortOrder(
	conn: DbOrTx,
	templateId: string,
	pairs: { id: string; sortOrder: number }[],
): Promise<void> {
	if (pairs.length === 0) return;
	const cases = sql.join(
		pairs.map((p) => sql`WHEN ${p.id}::uuid THEN ${p.sortOrder}::integer`),
		sql` `,
	);
	await conn
		.update(meetingTemplateBeats)
		.set({
			sortOrder: sql`(CASE ${meetingTemplateBeats.id} ${cases} END)::integer`,
		})
		.where(
			and(
				eq(meetingTemplateBeats.templateId, templateId),
				// REDUNDANT today, same as the single-row version this replaced: an
				// `id` is a primary key, so `inArray` below already pins exactly
				// these rows and no others. Kept for the same reason — see the
				// TRIGGER note there — and because it is what scopes the ONE bulk
				// statement to one template for a reader skimming the SQL, now that
				// there is no longer a separate statement per row to read that off of.
				inArray(
					meetingTemplateBeats.id,
					pairs.map((p) => p.id),
				),
			),
		);
}

/**
 * Reassign 0..N-1 to `orderedIds`, the full row set of one template, in the
 * given order.
 *
 * `meeting_template_beats_order_unique` is a plain, immediately-checked unique
 * index on `(template_id, sort_order)` — not deferrable — so writing the
 * target positions directly collides on almost every reorder: moving row 2
 * into slot 0 tries to give it the same value a still-untouched row already
 * holds, mid-transaction, before this function gets a chance to move that row
 * out of the way. Two passes fix it: first relocate every row to a distinct
 * NEGATIVE value (impossible to collide with the never-negative 0..N-1 target
 * range, and pairwise distinct from each other by construction), then assign
 * the real final position — by then nothing else occupies 0..N-1. Every writer
 * in this module keeps `sortOrder` at 0..N-1 with no gaps, so the negative
 * range can never already be in use.
 *
 * TWO bulk statements, not 2N sequential ones (#task-10). The original
 * shape — one `UPDATE … WHERE id = $1` per row, per pass — issued 2N round
 * trips inside this one transaction, holding a row lock on every touched beat
 * for the whole span: measured at 200 rows (`MAX_TEMPLATE_BEATS`, 400
 * statements) via `moveAgendaRow` against a real local Postgres, ~170-187ms
 * per reorder click, three consecutive runs, 2026-08-21. The two-statement
 * `CASE`-based version below does the identical two-pass reassignment —
 * same negative-floor relocation, same final 0..N-1 pass, same
 * `(templateId, sortOrder)` collision avoidance — in ~11-16ms, measured the
 * same way immediately afterward: same machine, same fixture, three runs.
 * ~12-16x faster from 2 round trips instead of 400, not from doing less work.
 */
async function renumberRows(
	conn: DbOrTx,
	templateId: string,
	orderedIds: string[],
): Promise<void> {
	if (orderedIds.length === 0) return;
	const floor = -orderedIds.length - 1;
	await bulkSetSortOrder(
		conn,
		templateId,
		orderedIds.map((id, i) => ({ id, sortOrder: floor - i })),
	);
	await bulkSetSortOrder(
		conn,
		templateId,
		orderedIds.map((id, i) => ({ id, sortOrder: i })),
	);
}

/** This template's row ids, in `sortOrder`. */
async function loadRowIds(
	conn: DbOrTx,
	templateId: string,
): Promise<{ id: string; sortOrder: number }[]> {
	return conn
		.select({
			id: meetingTemplateBeats.id,
			sortOrder: meetingTemplateBeats.sortOrder,
		})
		.from(meetingTemplateBeats)
		.where(eq(meetingTemplateBeats.templateId, templateId))
		.orderBy(asc(meetingTemplateBeats.sortOrder));
}

/** A caller-supplied row's current state, as resolved by `findRow`, plus the
 *  template it was actually found in — which the mutators compare against
 *  `ensureAgendaDraft`'s answer to decide how to re-locate it. `label` is here
 *  for `translateRow`'s identity check, not for any patch. */
type RowLookup = {
	sortOrder: number;
	templateId: string;
	label: string;
} & MarkFields &
	RoleBinding;

/**
 * The template ids a caller-supplied row id may legitimately name for this
 * meeting: the meeting's own, plus — when that is a PRIVATE copy — the shared
 * template it was forked from.
 *
 * The second arm is what makes a concurrent first write survivable. An
 * officer's page loaded before any edit holds the SHARED template's row ids
 * (`loadAgendaDraft` returns that row's own content for an unforked meeting),
 * and the moment any write forks, those ids stop resolving — so the officer's
 * second, already-in-flight save answered "That agenda row is not part of this
 * meeting." for a row plainly on their screen. It is also the everyday
 * stale-tab case, not only the race.
 *
 * The source is identified by `key`, which is the provenance a private copy
 * keeps verbatim (`copyTemplateForMeeting`'s docblock says so), narrowed to
 * templates this club may see at all — global or its own, never private. Both
 * candidates are returned when a global and a club-scoped template share a
 * key, since either is a legitimate pre-fork shape and neither is foreign.
 *
 * This widens what may be READ, never what may be WRITTEN: every mutator's own
 * final statement is scoped to `ensureAgendaDraft`'s resolved template, so a
 * row resolved through the source arm still only ever moves the private copy's
 * own row.
 */
async function addressableTemplateIds(
	conn: DbOrTx,
	meetingId: string,
): Promise<string[]> {
	const [meeting] = await conn
		.select({ templateId: meetings.templateId, clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting?.templateId) return [];
	const [own] = await conn
		.select({
			key: meetingTemplates.key,
			meetingId: meetingTemplates.meetingId,
		})
		.from(meetingTemplates)
		.where(eq(meetingTemplates.id, meeting.templateId))
		.limit(1);
	if (!own) return [];
	if (own.meetingId === null) return [meeting.templateId];
	const sources = await conn
		.select({ id: meetingTemplates.id })
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.key, own.key),
				isNull(meetingTemplates.meetingId),
				or(
					isNull(meetingTemplates.clubId),
					eq(meetingTemplates.clubId, meeting.clubId),
				),
			),
		);
	return [meeting.templateId, ...sources.map((s) => s.id)];
}

/**
 * A caller-supplied row's current state, resolved against the templates this
 * meeting can address (see `addressableTemplateIds`) — BEFORE
 * `ensureAgendaDraft` runs. Null when the row belongs to none of them.
 *
 * This has to run before the fork, not after, for two reasons at once. First,
 * tenancy: rejecting here means a foreign row never triggers a fork write at
 * all — a bad-actor request touches nothing. Second, and the reason this
 * resolves `sortOrder` rather than trusting the id outright: `loadAgendaDraft`
 * now returns a SHARED template's own content for a meeting that has not been
 * edited yet (correction 1), so the row ids an officer is acting on may be
 * the shared template's — and a fork replaces that pointer with a private copy
 * carrying entirely new row ids.
 * `copyTemplateForMeeting` preserves `sort_order` verbatim, and the
 * `(template_id, sort_order)` unique index guarantees at most one row per
 * value, so capturing the PRE-fork sortOrder and re-finding it in the
 * POST-fork template (see the mutators below) is what makes a meeting's very
 * first edit land on the row the officer actually clicked, instead of erroring
 * or silently misfiring.
 *
 * The mutators translate through `translateRow` — by `sortOrder`, and only
 * after checking the row it lands on is the SAME BEAT — exactly when the
 * template this row was found in is NOT the one the write lands on
 * (`found.templateId !== templateId`), and match by `id` otherwise. That
 * covers the fork this same call performed AND the fork a concurrent call
 * performed a moment earlier;
 * the older `forked` flag saw only the first, so the loser of a race resolved
 * a shared row id and then filtered on it against the private copy, matching
 * nothing. Matching by sortOrder UNCONDITIONALLY would reopen a different bug:
 * `findRow` and a mutator's own final statement
 * are separate round trips under READ COMMITTED, so a concurrent renumber
 * that commits in between could leave the target sortOrder pointing at a
 * DIFFERENT row by the time the final statement runs — no error, no unique
 * violation, just a wrong-row write. `id` is immutable and never reassigned
 * by a renumber, so matching by id has no such window; sortOrder-matching is
 * safe only for a row this SAME transaction just created a moment earlier,
 * which no concurrent transaction can have touched (it isn't committed yet).
 *
 * Also returns the row's CURRENT marks and role bindings, so a patch can be
 * validated against the row as it will read AFTER the patch — see
 * `assertMarks` and `assertRepeatBinding`. Both of those checks run on this
 * PRE-fork read, which is exact rather than an approximation: a fork copies
 * every column verbatim, so the merged row is identical either way, and
 * refusing here means an illegal patch never triggers a fork write.
 */
async function findRow(
	conn: DbOrTx,
	meetingId: string,
	rowId: string,
): Promise<RowLookup | null> {
	const addressable = await addressableTemplateIds(conn, meetingId);
	if (addressable.length === 0) return null;
	const [row] = await conn
		.select({
			sortOrder: meetingTemplateBeats.sortOrder,
			templateId: meetingTemplateBeats.templateId,
			label: meetingTemplateBeats.label,
			kind: meetingTemplateBeats.kind,
			roleKey: meetingTemplateBeats.roleKey,
			repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
			markGreen: meetingTemplateBeats.markGreen,
			markYellow: meetingTemplateBeats.markYellow,
			markRed: meetingTemplateBeats.markRed,
		})
		.from(meetingTemplateBeats)
		.where(
			and(
				eq(meetingTemplateBeats.id, rowId),
				inArray(meetingTemplateBeats.templateId, addressable),
			),
		)
		.limit(1);
	return row ?? null;
}

/** The one sentence every mutator answers a row it will not touch with. */
const ROW_NOT_IN_MEETING_MESSAGE =
	"That agenda row is not part of this meeting.";

/**
 * `found`'s counterpart on `templateId` — the private copy's OWN row for a row
 * the caller named on the shared template it was forked from — or a thrown
 * `ROW_NOT_IN_MEETING_MESSAGE`.
 *
 * The translation is `(templateId, sortOrder)`, and that mapping is exact ONLY
 * while the copy is still verbatim. `renumberRows` reassigns a dense 0..N-1 on
 * every add, move and remove, so one inserted or deleted row shifts every later
 * `sortOrder` by one — after which a caller holding the SHARED template's row
 * ids (a stale tab, a second editor) resolves through `addressableTemplateIds`'
 * source arm, translates to a `sortOrder` that now belongs to a DIFFERENT beat,
 * and gets that beat patched or deleted with a success response. Before the
 * source arm existed the same request threw this error; translating without
 * checking turned a safe, visible rejection into a silent wrong-row write.
 *
 * So the target's identity is verified before it is returned: same `kind`, and
 * the same `label` OR the same `roleKey`. Either half alone is too weak —
 * `kind` repeats across a whole agenda, and two beats can share a label — and
 * requiring BOTH is too strong, because the everyday case this translation
 * exists for is a second in-flight POST whose sibling already renamed the row
 * (see `AGENDA_CONCURRENT_EDIT_MESSAGE`'s docblock), where the label has
 * legitimately moved on but the role binding has not. The `roleKey` arm
 * requires a NON-NULL key on both sides on purpose: two section beats both
 * carrying `null` would otherwise "match" on nothing at all.
 *
 * The verbatim case — the double-POST this whole path exists for — passes
 * trivially, since a copy differs from its source in no column at all. The
 * diverged case is rejected exactly as it was before the source arm shipped.
 *
 * Returns the target's own `id`, and every caller then filters on THAT rather
 * than on `sortOrder`: an id is immutable, so the verify-then-write gap cannot
 * be re-pointed by a renumber the way a position can.
 */
async function translateRow(
	conn: DbOrTx,
	templateId: string,
	found: RowLookup,
): Promise<{ id: string } & RowLookup> {
	const [target] = await conn
		.select({
			id: meetingTemplateBeats.id,
			sortOrder: meetingTemplateBeats.sortOrder,
			templateId: meetingTemplateBeats.templateId,
			label: meetingTemplateBeats.label,
			kind: meetingTemplateBeats.kind,
			roleKey: meetingTemplateBeats.roleKey,
			repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
			markGreen: meetingTemplateBeats.markGreen,
			markYellow: meetingTemplateBeats.markYellow,
			markRed: meetingTemplateBeats.markRed,
		})
		.from(meetingTemplateBeats)
		.where(
			and(
				eq(meetingTemplateBeats.templateId, templateId),
				eq(meetingTemplateBeats.sortOrder, found.sortOrder),
			),
		)
		.limit(1);
	if (!target) throw new Error(ROW_NOT_IN_MEETING_MESSAGE);
	const sameLabel = target.label === found.label;
	const sameRole = found.roleKey !== null && target.roleKey === found.roleKey;
	if (target.kind !== found.kind || !(sameLabel || sameRole)) {
		throw new Error(ROW_NOT_IN_MEETING_MESSAGE);
	}
	return target;
}

/**
 * Add a row to the meeting's agenda, immediately after `afterRowId` (or at
 * the end, when null), and return it.
 *
 * Refuses past `MAX_TEMPLATE_BEATS`: that cap is enforced at
 * `loadTemplateBeats`, the one seam every renderer reads a template through,
 * but enforcing it there ALONE means an officer could build a template the
 * renderer then silently truncates. Enforced here too, at the writer.
 */
export async function addAgendaRow(input: {
	meetingId: string;
	afterRowId: string | null;
	kind: "section" | "role" | "event";
}): Promise<AgendaDraftRow> {
	return database.transaction(async (tx) => {
		// Resolved against the PRE-fork pointer — see `findRow`.
		const afterRow =
			input.afterRowId === null
				? null
				: await findRow(tx, input.meetingId, input.afterRowId);
		if (input.afterRowId !== null && afterRow === null) {
			throw new Error(ROW_NOT_IN_MEETING_MESSAGE);
		}

		const { templateId } = await ensureAgendaDraft(tx, input.meetingId);
		const rows = await loadRowIds(tx, templateId);
		if (rows.length >= MAX_TEMPLATE_BEATS) {
			throw new Error(
				`This agenda is too long (max ${MAX_TEMPLATE_BEATS} rows).`,
			);
		}

		// The caller's id names a row on THIS template already, unless it came
		// from a DIFFERENT one — this call forked, or a concurrent first write
		// forked a moment before it. `translateRow` resolves the copy's own row
		// and refuses if the copy has diverged. See `findRow`.
		let afterId: string | null = input.afterRowId;
		if (afterRow !== null && afterRow.templateId !== templateId) {
			afterId = (await translateRow(tx, templateId, afterRow)).id;
		}

		const at =
			afterId === null
				? rows.length
				: rows.findIndex((r) => r.id === afterId) + 1;
		if (afterId !== null && at === 0) {
			// Both arms of `afterId` name a row read from THIS template inside
			// THIS transaction, so a miss here is corruption, not a normal
			// "not found".
			throw new Error("Failed to place the new agenda row.");
		}

		// A temp sortOrder strictly above every existing row's, so the INSERT
		// itself can never collide with the unique index — `renumberRows` below
		// then moves everything (this new row included) to its real position.
		const maxSort = rows.reduce((m, r) => Math.max(m, r.sortOrder), -1);
		const [created] = await tx
			.insert(meetingTemplateBeats)
			.values({
				templateId,
				sortOrder: maxSort + 1,
				kind: input.kind,
				label: input.kind === "section" ? "NEW SECTION" : "New item",
				minutes: 0,
			})
			.returning({ id: meetingTemplateBeats.id });
		if (!created) throw new Error("Failed to add the agenda row.");

		const reorderedIds = rows.map((r) => r.id);
		reorderedIds.splice(at, 0, created.id);
		await renumberRows(tx, templateId, reorderedIds);

		const [row] = await tx
			.select()
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.id, created.id))
			.limit(1);
		if (!row) throw new Error("Failed to add the agenda row.");
		return {
			id: row.id,
			sortOrder: row.sortOrder,
			kind: row.kind,
			label: row.label,
			detail: row.detail,
			minutes: row.minutes,
			roleKey: row.roleKey,
			repeatsRoleKey: row.repeatsRoleKey,
			flex: row.flex,
			handoff: row.handoff,
			markGreen: row.markGreen,
			markYellow: row.markYellow,
			markRed: row.markRed,
		};
	});
}

/** Edit a row's content. Cheap, DB-free validation up front; state-dependent
 *  validation (marks, declared role keys) and the write itself happen inside
 *  the transaction, scoped to the caller's own template. */
export async function updateAgendaRow(input: {
	meetingId: string;
	rowId: string;
	patch: Partial<
		Pick<
			AgendaDraftRow,
			| "label"
			| "detail"
			| "minutes"
			| "roleKey"
			| "repeatsRoleKey"
			| "flex"
			| "handoff"
			| "markGreen"
			| "markYellow"
			| "markRed"
		>
	>;
}): Promise<void> {
	const { patch } = input;
	if (Object.keys(patch).length === 0) {
		throw new Error("Nothing to update.");
	}
	if (patch.label != null) {
		assertWithin(patch.label, MAX_TEMPLATE_LABEL_CHARS, "label");
	}
	if (patch.detail != null) {
		assertWithin(patch.detail, MAX_TEMPLATE_DETAIL_CHARS, "note");
	}
	if (patch.roleKey != null) {
		assertWithin(patch.roleKey, MAX_TEMPLATE_LABEL_CHARS, "role reference");
	}
	if (patch.repeatsRoleKey != null) {
		assertWithin(
			patch.repeatsRoleKey,
			MAX_TEMPLATE_LABEL_CHARS,
			"repeat-role reference",
		);
	}
	if (
		patch.minutes != null &&
		(patch.minutes < 0 || patch.minutes > MAX_BEAT_MINUTES)
	) {
		throw new Error(`Minutes must be between 0 and ${MAX_BEAT_MINUTES}.`);
	}

	await database.transaction(async (tx) => {
		// Resolved against the PRE-fork pointer — see `findRow`.
		const found = await findRow(tx, input.meetingId, input.rowId);
		if (!found) {
			throw new Error(ROW_NOT_IN_MEETING_MESSAGE);
		}
		// Validated against the row as it will read AFTER this patch, not the
		// patch in isolation — see `assertMarks` and `assertRepeatBinding`. Both
		// run BEFORE `ensureAgendaDraft`, so a refused patch triggers no fork.
		assertMarks(found, patch);
		assertRepeatBinding(found, patch);

		const { templateId } = await ensureAgendaDraft(tx, input.meetingId);
		// Against the FINAL templateId: a fork copies meeting_template_roles too,
		// so this is the fresh declared set for whichever template the row is
		// about to belong to.
		await assertDeclaredRoleKeys(tx, templateId, patch);

		// By id when the template was already private (exact, and immune to a
		// concurrent renumber — see `findRow`'s docblock); through
		// `translateRow`, which re-checks identity, when the caller's id came
		// from the shared template this meeting was forked from.
		let rowId = input.rowId;
		if (found.templateId !== templateId) {
			const target = await translateRow(tx, templateId, found);
			rowId = target.id;
			// Re-run against the row this write will actually LAND on. The pair
			// above ran against `found`, which is a different row in a different
			// template, and the two can disagree: a sibling edit that set all
			// three marks on the copy leaves the source with none, so
			// `{markGreen: null}` merges to "none" there and to a partial set
			// here — the exact hole `assertMarks` exists to refuse.
			assertMarks(target, patch);
			assertRepeatBinding(target, patch);
		}
		// Scoped to THIS meeting's template either way: the row id is
		// caller-supplied, and without the template predicate an officer of one
		// club could edit another's agenda by id.
		const updated = await tx
			.update(meetingTemplateBeats)
			.set(patch)
			.where(
				and(
					eq(meetingTemplateBeats.templateId, templateId),
					eq(meetingTemplateBeats.id, rowId),
				),
			)
			.returning({ id: meetingTemplateBeats.id });
		if (updated.length === 0) {
			throw new Error(ROW_NOT_IN_MEETING_MESSAGE);
		}
	});
}

/** Remove a row and close the gap in `sortOrder`. */
export async function removeAgendaRow(input: {
	meetingId: string;
	rowId: string;
}): Promise<void> {
	await database.transaction(async (tx) => {
		const found = await findRow(tx, input.meetingId, input.rowId);
		if (!found) {
			throw new Error(ROW_NOT_IN_MEETING_MESSAGE);
		}
		const { templateId } = await ensureAgendaDraft(tx, input.meetingId);
		// See `updateAgendaRow` — a delete resolved by position alone against a
		// copy that has since renumbered destroys a NEIGHBOURING beat and
		// answers success.
		const rowId =
			found.templateId !== templateId
				? (await translateRow(tx, templateId, found)).id
				: input.rowId;
		const deleted = await tx
			.delete(meetingTemplateBeats)
			.where(
				and(
					eq(meetingTemplateBeats.templateId, templateId),
					eq(meetingTemplateBeats.id, rowId),
				),
			)
			.returning({ id: meetingTemplateBeats.id });
		if (deleted.length === 0) {
			throw new Error(ROW_NOT_IN_MEETING_MESSAGE);
		}
		const rest = await loadRowIds(tx, templateId);
		await renumberRows(
			tx,
			templateId,
			rest.map((r) => r.id),
		);
	});
}

/** Swap a row with its immediate neighbour. A no-op past either end. */
export async function moveAgendaRow(input: {
	meetingId: string;
	rowId: string;
	direction: "up" | "down";
}): Promise<void> {
	await database.transaction(async (tx) => {
		const found = await findRow(tx, input.meetingId, input.rowId);
		if (!found) {
			throw new Error(ROW_NOT_IN_MEETING_MESSAGE);
		}
		const { templateId } = await ensureAgendaDraft(tx, input.meetingId);
		// See `updateAgendaRow` — resolving by position alone against a copy
		// that has since renumbered reorders a NEIGHBOURING beat.
		const rowId =
			found.templateId !== templateId
				? (await translateRow(tx, templateId, found)).id
				: input.rowId;
		const rows = await loadRowIds(tx, templateId);
		const at = rows.findIndex((r) => r.id === rowId);
		if (at === -1) {
			// Same corruption guard as `addAgendaRow`'s post-resolution check.
			throw new Error(ROW_NOT_IN_MEETING_MESSAGE);
		}
		const to = input.direction === "up" ? at - 1 : at + 1;
		if (to < 0 || to >= rows.length) return;

		const reorderedIds = rows.map((r) => r.id);
		const [moved] = reorderedIds.splice(at, 1);
		if (!moved) return;
		reorderedIds.splice(to, 0, moved);
		await renumberRows(tx, templateId, reorderedIds);
	});
}

// ---------------------------------------------------------------------------
// Roles — adding and removing the roles a meeting's own template declares.
// Beats bind to a role by KEY (`roleKey` / `repeatsRoleKey`), and a key is
// stable across a fork (`copyTemplateForMeeting` preserves it verbatim) —
// unlike a row id, it needs no pre-fork/post-fork translation, so these
// mutators resolve straight off `ensureAgendaDraft`'s `templateId` with no
// `forked` branching at all.
// ---------------------------------------------------------------------------

/** `Zoom Master` → `zoom_master`, uniquified against the template's own keys.
 *  Keys are the stable, rename-proof identity every surface binds on (#368), so
 *  they are derived once at creation and never follow a later rename. */
function deriveRoleKey(name: string, taken: Set<string>): string {
	const base =
		[...name.toLowerCase()]
			.map((c) => (/[a-z0-9]/.test(c) ? c : "_"))
			.join("")
			.replace(/_+/g, "_")
			.replace(/^_|_$/g, "") || "role";
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}_${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/**
 * Add a role to the meeting's own template and materialize it immediately.
 * A role with no `role_definitions` row can never own a slot
 * (`role_slots.role_definition_id` is NOT NULL and restricting), so an
 * unmaterialized role would be a row nobody could ever sign up for.
 *
 * Materializes by inserting exactly ONE `role_definitions` row for the new
 * role — not by calling `materializeTemplateRoles` again for the WHOLE role
 * set at `templateId`. Two reasons, neither of them data pollution anymore:
 * `ensureAgendaDraft`'s fork (task-8b) already materializes every
 * PRE-EXISTING declared role and re-points this meeting's own slots onto
 * them, in the SAME transaction, before this function's own logic ever
 * runs — so by the time control reaches here, `templateId`'s current role
 * set is already correctly materialized, and re-running the whole-set call
 * would just repeat that work, a no-op per row via `onConflictDoNothing` but
 * still a wasted read-and-attempt over every OTHER role for the sake of
 * adding one. And `materializeTemplateRoles` returns `void`, not the row(s)
 * it inserted, while this call needs the fresh row's `id` back immediately —
 * `generateSlotRows([def], meetingId)` a few lines down can't run without
 * it. (Before task-8b, this insert being scoped to one row was ALSO what
 * kept the whole-set call from re-inserting every pre-existing role as a
 * second, orphaned `role_definitions` row parallel to the ones the meeting's
 * slots still referenced on the old shared template — that hazard is now the
 * fork's job to prevent, not this function's.)
 */
export async function addAgendaRole(input: {
	meetingId: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	isSpeakerRole: boolean;
}): Promise<AgendaDraftRole> {
	assertWithin(input.name, MAX_TEMPLATE_LABEL_CHARS, "role name");
	if (input.defaultCount < 0 || input.defaultCount > MAX_ROLE_REPEAT_SLOTS) {
		throw new Error(
			`A role can have between 0 and ${MAX_ROLE_REPEAT_SLOTS} places.`,
		);
	}

	return database.transaction(async (tx) => {
		const { templateId } = await ensureAgendaDraft(tx, input.meetingId);
		const [meeting] = await tx
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, input.meetingId))
			.limit(1);
		if (!meeting) throw new Error("Meeting not found.");

		const existing = await tx
			.select({
				key: meetingTemplateRoles.key,
				sortOrder: meetingTemplateRoles.sortOrder,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId));
		if (existing.length >= MAX_TEMPLATE_ROLES) {
			throw new Error(
				`This agenda has too many roles (max ${MAX_TEMPLATE_ROLES}).`,
			);
		}
		const key = deriveRoleKey(input.name, new Set(existing.map((r) => r.key)));
		const sortOrder =
			existing.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 10;

		await tx.insert(meetingTemplateRoles).values({
			templateId,
			key,
			name: input.name,
			category: input.category,
			defaultCount: input.defaultCount,
			sortOrder,
			isSpeakerRole: input.isSpeakerRole,
		});

		// Materialize just this one role — see the docblock above for why NOT
		// `materializeTemplateRoles`.
		//
		// A PLAIN insert, deliberately, and it rests on an invariant held
		// elsewhere: `deriveRoleKey` uniquifies against `meeting_template_roles`
		// ONLY, so (clubId, templateId, key) can be free of a declaration and
		// still be TAKEN in `role_definitions` if anything ever leaves one
		// behind. `removeAgendaRole` is the only thing that can, and it deletes
		// by (club, template, key) rather than by the ids a slot resolved to,
		// precisely so it cannot. That was not true until this fix wave — a role
		// removed while holding no slot orphaned its definition, and re-adding
		// the same name surfaced a raw
		// `role_definitions_club_template_key_unique` violation, permanently.
		// Anything that weakens that delete has to come back here first.
		const [def] = await tx
			.insert(roleDefinitions)
			.values({
				clubId: meeting.clubId,
				templateId,
				key,
				name: input.name,
				category: input.category,
				defaultCount: input.defaultCount,
				sortOrder,
				isSpeakerRole: input.isSpeakerRole,
			})
			.returning({
				id: roleDefinitions.id,
				defaultCount: roleDefinitions.defaultCount,
				enabled: roleDefinitions.enabled,
			});
		if (!def) throw new Error("Failed to add the agenda role.");
		const rows = generateSlotRows([def], input.meetingId);
		if (rows.length > 0) await tx.insert(roleSlots).values(rows);

		return {
			key,
			name: input.name,
			category: input.category,
			defaultCount: input.defaultCount,
			isSpeakerRole: input.isSpeakerRole,
		};
	});
}

/** What a role removal (or preview) resolves for one meeting + role key: who
 *  currently holds it, and which `role_definitions` row(s) its own slots
 *  actually reference.
 *
 *  Scoped by `roleSlots.meetingId` FIRST, then joined to `roleDefinitions` by
 *  exact id — once a slot is pinned to this one meeting, which role it names
 *  cannot resolve to a different meeting's row; there is no id here for a
 *  caller to spoof, and `roleKey` only narrows WHICH of this meeting's own
 *  roles to read.
 *
 *  Deliberately does NOT filter by `role_definitions.templateId` against the
 *  meeting's CURRENT template pointer. A meeting's live slots can reference a
 *  `role_definitions` row materialized against a template id that is no
 *  longer what `meetings.template_id` points at — the common case being a
 *  meeting still on its original SHARED template, which is what every
 *  meeting created before per-meeting private copies existed looks like
 *  (`loadAgendaDraft`'s "correction 1" docblock). Filtering on the current
 *  pointer here is what let `removeAgendaRole`'s first version silently
 *  release nothing on that path while reporting a name as released — the
 *  resolution has to be "what does this meeting's OWN slot actually point
 *  at", not "what does the template it currently names declare". */
async function resolveHeldSlotsForRole(
	conn: DbOrTx,
	meetingId: string,
	roleKey: string,
): Promise<{ released: ReleasedHolder[]; roleDefinitionIds: string[] }> {
	const rows = await conn
		.select({
			roleDefinitionId: roleSlots.roleDefinitionId,
			memberId: roleSlots.assignedMemberId,
			guestId: roleSlots.assignedGuestId,
			memberName: members.name,
			guestName: guests.name,
			roleName: roleDefinitions.name,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
		.leftJoin(guests, eq(guests.id, roleSlots.assignedGuestId))
		.where(
			and(eq(roleSlots.meetingId, meetingId), eq(roleDefinitions.key, roleKey)),
		);

	return {
		released: rows
			.filter((r) => r.memberId != null || r.guestId != null)
			.map((r) => ({
				memberId: r.memberId,
				guestId: r.guestId,
				name: r.memberName ?? r.guestName ?? "Someone",
				roleName: r.roleName,
			})),
		roleDefinitionIds: [...new Set(rows.map((r) => r.roleDefinitionId))],
	};
}

/**
 * Who a role removal would release, WITHOUT removing anything. PURE READ —
 * the same rule `planTemplateConversion` follows: showing an officer what a
 * change would do must not itself change anything. The dialog leads with
 * names because a released holder cannot be told afterwards: `notifications
 * .slot_id` is NOT NULL and ON DELETE CASCADE to `role_slots`, so a row
 * enqueued against a slot the same transaction deletes is destroyed before
 * the poller could ever see it.
 */
export async function planRoleRemoval(input: {
	meetingId: string;
	roleKey: string;
}): Promise<ReleasedHolder[]> {
	const [meeting] = await database
		.select({ templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!meeting?.templateId) return [];

	const { released } = await resolveHeldSlotsForRole(
		database,
		input.meetingId,
		input.roleKey,
	);
	return released;
}

/**
 * Remove a role from the meeting's own template: its slots (released before
 * they disappear, same as `applyTemplateConversion`), its own
 * `role_definitions` row if this meeting's template privately owns it, and
 * every beat bound to it — by `roleKey` (the beat IS the role's own row) OR
 * `repeatsRoleKey` (a beat inside that role's repeat block that names it
 * without owning it — e.g. the contest's ballot minute). `buildTemplateRows`
 * drops a beat naming an undeclared role rather than rendering it, so leaving
 * either binding behind is an invisible row that would silently reappear if
 * the key were ever reused.
 *
 * The slots to release are resolved via `resolveHeldSlotsForRole` — by what
 * THIS meeting's own `role_slots` actually reference, never by matching
 * `role_definitions.templateId` against `ensureAgendaDraft`'s resolved
 * `templateId` — see that helper's docblock for why the latter silently
 * missed the fork case entirely. `role_slots.meetingId` is the exact tenant
 * boundary there, so no club/template predicate is needed to keep this
 * scoped to the caller's own meeting.
 *
 * The `role_definitions` row is deleted by (club, template, KEY) — the
 * template being `ensureAgendaDraft`'s resolved, this-meeting's-own private
 * one — and NOT by the ids `resolveHeldSlotsForRole` returned. That
 * distinction is the whole of this paragraph, because deleting by resolved id
 * makes the delete conditional on a SLOT existing, and a role can legitimately
 * hold none: `addAgendaRole` accepts `defaultCount: 0` (the editor's Places
 * field coerces empty to 0), and `applyRemoveRoleSlot` has no last-slot guard.
 * With no slot there is nothing to resolve, so the definition outlived its own
 * declaration and its beats — staying `enabled` and template-scoped, which
 * kept the meeting page's "+ Add role" picker offering a role the agenda no
 * longer declared, and, worse, made the name PERMANENTLY unusable on that
 * meeting: `deriveRoleKey` uniquifies against `meeting_template_roles` only,
 * so re-adding derived the same key and the plain insert in `addAgendaRole`
 * violated `role_definitions_club_template_key_unique` with a raw Postgres
 * string. Keying on the role key is a strict superset of the resolved ids
 * within this template, so nothing that used to be deleted stops being.
 *
 * The `templateId` predicate is the OWNERSHIP GATE, and it is load-bearing
 * rather than incidental scoping. `role_definitions` is keyed per (club,
 * template), NOT per meeting — two meetings of ONE club that both still point
 * at the same SHARED template also share its materialized definitions, so
 * deleting a row this meeting's slot merely REFERENCES (rather than privately
 * owns) would either hit `role_slots.role_definition_id`'s RESTRICT from the
 * OTHER meeting's still-live slot (an unrelated meeting's edit throwing on this
 * one's removal) or, worse, silently remove a definition a sibling meeting's
 * unconverted agenda still declares. `templateId` here is this meeting's own
 * private copy BY CONSTRUCTION (`ensureAgendaDraft` forks one if it has to), so
 * the gate holds on the fork path too. Leaving a still-shared definition alone
 * is deliberate, not a leak: this meeting's own slots for it are still fully
 * released and deleted either way. A correct fix that also reconciles the
 * SHARED row (copy-then-repoint only this meeting's slots) is bigger than
 * this task and is filed separately — do not "fix" this by materializing on
 * fork and repointing inside `ensureAgendaDraft`.
 *
 * Rejects an undeclared `roleKey` BEFORE `ensureAgendaDraft` runs, against the
 * meeting's current (possibly still-shared) template — the same reason
 * `addAgendaRow`/`updateAgendaRow` resolve a caller-supplied row before
 * forking (`findRow`'s docblock): a fork is a real write (it repoints
 * `meetings.template_id`), and a bad key should not trigger one for a
 * no-op removal. `roleKey` is stable across a fork, so this pre-fork read is
 * exact, not an approximation later reconciled.
 *
 * `planRoleRemoval`'s resolution runs again INSIDE this transaction, after
 * the fork — not reused from a call made before opening it — so the names
 * reported and the rows deleted come from one snapshot. A claim landing in
 * the gap between an earlier read and this transaction would otherwise be
 * deleted without ever appearing in a list the caller is told is complete.
 */
export async function removeAgendaRole(input: {
	meetingId: string;
	roleKey: string;
	actorMemberId: string | null;
}): Promise<ReleasedHolder[]> {
	const [preFork] = await database
		.select({ templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!preFork?.templateId) {
		throw new Error(
			"Only a meeting with a meeting type can have its agenda edited.",
		);
	}
	const [declared] = await database
		.select({ key: meetingTemplateRoles.key })
		.from(meetingTemplateRoles)
		.where(
			and(
				eq(meetingTemplateRoles.templateId, preFork.templateId),
				eq(meetingTemplateRoles.key, input.roleKey),
			),
		)
		.limit(1);
	if (!declared) {
		throw new Error(`"${input.roleKey}" is not a role this template declares.`);
	}

	return database.transaction(async (tx) => {
		const { templateId } = await ensureAgendaDraft(tx, input.meetingId);
		const [owner] = await tx
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, input.meetingId))
			.limit(1);
		if (!owner) throw new Error("Meeting not found.");

		const { released, roleDefinitionIds: defIds } =
			await resolveHeldSlotsForRole(tx, input.meetingId, input.roleKey);
		if (defIds.length > 0) {
			// Release, then delete — "a slot is released before it disappears"
			// stays true at every intermediate state. The speech is Person-owned
			// (ADR-0009), so it survives regardless. Scoped to `meetingId` even
			// though `defIds` already came from a meetingId-scoped join, because
			// this is the statement that actually performs the write.
			await tx
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					assignedGuestId: null,
					speechId: null,
					status: "open",
					claimedAt: null,
				})
				.where(
					and(
						eq(roleSlots.meetingId, input.meetingId),
						inArray(roleSlots.roleDefinitionId, defIds),
					),
				);
			await tx
				.delete(roleSlots)
				.where(
					and(
						eq(roleSlots.meetingId, input.meetingId),
						inArray(roleSlots.roleDefinitionId, defIds),
					),
				);
		}

		// OUTSIDE the `defIds` block, and keyed on the ROLE KEY rather than on
		// the ids those slots resolved to — see the docblock above. A role that
		// holds no slot resolves no ids at all, and this delete is exactly as
		// necessary there. Still ownership-gated: `roleDefScope` pins (club,
		// template), and `templateId` is this meeting's own private copy, so a
		// definition merely REFERENCED through a still-shared template is left in
		// place. After the slot deletes, never before —
		// `role_slots.role_definition_id` is ON DELETE RESTRICT.
		await tx
			.delete(roleDefinitions)
			.where(
				and(
					roleDefScope(owner.clubId, templateId),
					eq(roleDefinitions.key, input.roleKey),
				),
			);

		// One statement, not two — either binding shape (`roleKey` or
		// `repeatsRoleKey`, correction 2) removes the beat; a future edit to
		// this can no longer touch one arm and forget the other.
		await tx
			.delete(meetingTemplateBeats)
			.where(
				and(
					eq(meetingTemplateBeats.templateId, templateId),
					or(
						eq(meetingTemplateBeats.roleKey, input.roleKey),
						eq(meetingTemplateBeats.repeatsRoleKey, input.roleKey),
					),
				),
			);
		await tx
			.delete(meetingTemplateRoles)
			.where(
				and(
					eq(meetingTemplateRoles.templateId, templateId),
					eq(meetingTemplateRoles.key, input.roleKey),
				),
			);
		// Close the gaps the beat delete just opened. `renumberRows` states that
		// every writer in this module keeps `sortOrder` at 0..N-1 with no gaps,
		// and that invariant is what lets its negative-floor pass be safe; this
		// was the one writer that left holes in it.
		const rest = await loadRowIds(tx, templateId);
		await renumberRows(
			tx,
			templateId,
			rest.map((r) => r.id),
		);

		await logActivity(tx, {
			clubId: owner.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_agenda_role_removed",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { roleKey: input.roleKey, released: released.length },
		});

		return released;
	});
}

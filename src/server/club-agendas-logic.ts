/**
 * The club's own agendas (#910): its club-owned templates, its DEFAULT agenda
 * (`clubs.default_template_id`, spec D6), and adopting the standard agenda.
 *
 * A `*-logic.ts` module for the two reasons this repo documents: a db-touching
 * export in a server-fn module drags `#/db` → `pg` into the client bundle, and a
 * query inside a `createServerFn` handler is unreachable from vitest.
 *
 * NO SESSION HERE. Every function takes a `clubId` its server fn resolved
 * through `requireClubTemplateEditor` (officer of an unarchived club), and an
 * `actorMemberId` from that same gate. What this module DOES own is the tenant
 * boundary for TEMPLATE ids, which are caller-supplied: every template-keyed
 * write resolves the row by `id AND club_id AND meeting_id IS NULL` inside the
 * write's own query, so another club's template, a global one and a meeting's
 * private copy all read as absent — "That club template no longer exists." —
 * and nothing is written.
 *
 * LOCK ORDER. Every write below takes the club write lock (`lockClubForWrite`)
 * first, then the club ROW `FOR NO KEY UPDATE`, then anything else. The first
 * serialises it with #909's save-as-club-template, which takes the same two in
 * the same order; the second is the strength that save chose so a writer that
 * already holds KEY SHARE on the club (any row it inserted that references the
 * club) never waits on it. It conflicts with itself, which is the
 * serialisation two concurrent adoptions and a concurrent set-default need.
 */
import { and, asc, count, eq, exists, gte, isNull, sql } from "drizzle-orm";
import { db as database } from "#/db";
import {
	clubs,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import {
	agendaMatchesStandard,
	type ComparableAgenda,
	privateCopyKey,
} from "#/lib/agenda-materialise";
import { GE_LOCKED_MESSAGE } from "#/lib/club-agendas-copy";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import {
	CLUB_TEMPLATE_NAME_MAX,
	parseClubTemplateFields,
} from "#/lib/club-template-key";
import { logActivity } from "./activity";
import { lockClubForWrite } from "./club-write-lock";
import { standardAgendaForClub } from "./meeting-agenda-edit-logic";
import {
	ApplyPreconditionError,
	applyTemplateConversion,
	CLUB_TEMPLATE_GONE_MESSAGE,
	copyTemplateContent,
	forkLegacyPointers,
	loadComparableCopy,
	nextClubTemplateKey,
	planTemplateConversion,
	releasesAnything,
	removesAnything,
	WouldReleaseError,
	WouldRemoveError,
} from "./meeting-templates-logic";

export { CLUB_TEMPLATE_GONE_MESSAGE };

/** `setClubDefaultTemplate` on a club template that exists but is disabled. */
export const CLUB_TEMPLATE_DISABLED_MESSAGE =
	"That template is disabled. Enable it first.";

/** Disabling the club's current default. */
export const DISABLE_DEFAULT_MESSAGE = "Clear it as the default first.";

/** A second adoption, or adopting over a default the club already chose. */
export const ALREADY_ADOPTED_MESSAGE =
	"Your club already has a default agenda.";

/** What adopting names the template, and the key it asks for. */
const ADOPTED_TEMPLATE_NAME = "Our standard agenda";
const ADOPTED_TEMPLATE_KEY = "standard";

/** A drizzle transaction handle. */
type Tx = Parameters<Parameters<(typeof database)["transaction"]>[0]>[0];

/** Every key-and-club predicate a TEMPLATE-keyed write must carry: this club's
 *  own row, never a global one and never a meeting's private copy. */
function ownedBy(clubId: string, templateId: string) {
	return and(
		eq(meetingTemplates.id, templateId),
		eq(meetingTemplates.clubId, clubId),
		isNull(meetingTemplates.meetingId),
	);
}

/**
 * The club row, locked, with the archive gate INSIDE that locked read
 * (CODING_STANDARDS.md, "gate INSIDE" a lock the write already holds): an
 * archive committing while this waited is seen rather than raced. Takes the
 * club write lock first — see the module header for the order.
 */
async function lockClubRow(tx: Tx, clubId: string) {
	await lockClubForWrite(tx, clubId);
	const [club] = await tx
		.select({
			archivedAt: clubs.archivedAt,
			defaultTemplateId: clubs.defaultTemplateId,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.for("no key update")
		.limit(1);
	if (!club) throw new Error("Club not found.");
	if (isClubArchived(club)) throw new Error(CLUB_ARCHIVED_MESSAGE);
	return club;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type ClubAgendaSummary = {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	/** Stored rows, section bands included. */
	beatCount: number;
	isDefault: boolean;
};

export type ClubAgendas = {
	templates: ClubAgendaSummary[];
	/** `clubs.default_template_id IS NOT NULL` — spec D13's definition. */
	adopted: boolean;
	/** The club's zone, which every meeting date on the page is shown in. */
	timezone: string;
};

/** The club's own templates for the Agendas page, with which one is the
 *  default. Global templates and private copies are not the club's to manage
 *  and are excluded IN THE QUERY. */
export async function listClubAgendas(clubId: string): Promise<ClubAgendas> {
	const [club] = await database
		.select({
			defaultTemplateId: clubs.defaultTemplateId,
			timezone: clubs.timezone,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!club) throw new Error("Club not found.");
	const rows = await database
		.select({
			id: meetingTemplates.id,
			name: meetingTemplates.name,
			description: meetingTemplates.description,
			enabled: meetingTemplates.enabled,
			beatCount: count(meetingTemplateBeats.id),
		})
		.from(meetingTemplates)
		.leftJoin(
			meetingTemplateBeats,
			eq(meetingTemplateBeats.templateId, meetingTemplates.id),
		)
		.where(
			and(
				eq(meetingTemplates.clubId, clubId),
				isNull(meetingTemplates.meetingId),
			),
		)
		.groupBy(meetingTemplates.id)
		.orderBy(asc(meetingTemplates.sortOrder), asc(meetingTemplates.name));
	return {
		templates: rows.map((r) => ({
			...r,
			beatCount: Number(r.beatCount),
			isDefault: r.id === club.defaultTemplateId,
		})),
		adopted: club.defaultTemplateId !== null,
		timezone: club.timezone,
	};
}

/** Whether the club has a default agenda — what locks the GE checkbox. */
export async function isClubAgendaAdopted(clubId: string): Promise<boolean> {
	const [club] = await database
		.select({ defaultTemplateId: clubs.defaultTemplateId })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return club?.defaultTemplateId != null;
}

/**
 * Refuse a CHANGE to `ge_introduces_functionaries` while the club has a
 * default agenda (spec D5). The setting shapes only the STANDARD agenda, so
 * once a club runs its own it would change nothing a meeting shows — and
 * letting it be ticked anyway is how an officer concludes the feature is
 * broken.
 *
 * A save that leaves the value as it is passes: the settings form posts the
 * checkbox with the Table Topics window and digital voting, and those must
 * stay saveable while the checkbox is locked.
 */
export async function assertGeChangeAllowed(
	clubId: string,
	geIntroducesFunctionaries: boolean,
): Promise<void> {
	const [club] = await database
		.select({
			geIntroducesFunctionaries: clubs.geIntroducesFunctionaries,
			defaultTemplateId: clubs.defaultTemplateId,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!club) throw new Error("Club not found.");
	if (
		club.defaultTemplateId !== null &&
		club.geIntroducesFunctionaries !== geIntroducesFunctionaries
	) {
		throw new Error(GE_LOCKED_MESSAGE);
	}
}

// ---------------------------------------------------------------------------
// Template management
// ---------------------------------------------------------------------------

/** Rename a club template. Name 1–80 characters after trimming; the `key` is
 *  untouched, so a copy made from the old name still traces back to it. */
export async function renameClubTemplate(input: {
	clubId: string;
	templateId: string;
	name: string;
	description: string | null;
}): Promise<void> {
	const parsed = parseClubTemplateFields(input.name, input.description);
	if ("error" in parsed) throw new Error(parsed.error);
	await database.transaction(async (tx) => {
		await lockClubRow(tx, input.clubId);
		const [updated] = await tx
			.update(meetingTemplates)
			.set({ name: parsed.name, description: parsed.description })
			.where(ownedBy(input.clubId, input.templateId))
			.returning({ id: meetingTemplates.id });
		if (!updated) throw new Error(CLUB_TEMPLATE_GONE_MESSAGE);
	});
}

/** "Copy of <name>", cut to the name limit by code points (what an officer
 *  counts), so a long name duplicates rather than failing validation. */
export function duplicateName(name: string): string {
	return [...`Copy of ${name}`].slice(0, CLUB_TEMPLATE_NAME_MAX).join("");
}

/**
 * Copy a club template, beats and roles, into a new ENABLED club template
 * named "Copy of …" under a fresh deduplicated key. Returns the new id.
 */
export async function duplicateClubTemplate(input: {
	clubId: string;
	templateId: string;
}): Promise<{ templateId: string }> {
	return database.transaction(async (tx) => {
		await lockClubRow(tx, input.clubId);
		const [source] = await tx
			.select({
				name: meetingTemplates.name,
				description: meetingTemplates.description,
				defaultLengthMinutes: meetingTemplates.defaultLengthMinutes,
				sortOrder: meetingTemplates.sortOrder,
			})
			.from(meetingTemplates)
			.where(ownedBy(input.clubId, input.templateId))
			.for("share")
			.limit(1);
		if (!source) throw new Error(CLUB_TEMPLATE_GONE_MESSAGE);
		const name = duplicateName(source.name);
		const key = await nextClubTemplateKey(tx, input.clubId, name);
		const [created] = await tx
			.insert(meetingTemplates)
			.values({
				clubId: input.clubId,
				meetingId: null,
				key,
				name,
				description: source.description,
				defaultLengthMinutes: source.defaultLengthMinutes,
				sortOrder: source.sortOrder,
				enabled: true,
			})
			.returning({ id: meetingTemplates.id });
		if (!created) throw new Error("Failed to copy the template.");
		await copyTemplateContent(tx, {
			fromTemplateId: input.templateId,
			toTemplateId: created.id,
		});
		return { templateId: created.id };
	});
}

/**
 * Enable or disable a club template. Disabling hides it from the meeting
 * picker (`listAvailableTemplates` filters on `enabled`). The club's CURRENT
 * default cannot be disabled — new meetings are copied from it — and the check
 * reads the default under the club lock, so a concurrent set-default cannot
 * slip in between.
 */
export async function setClubTemplateEnabled(input: {
	clubId: string;
	templateId: string;
	enabled: boolean;
}): Promise<void> {
	await database.transaction(async (tx) => {
		const club = await lockClubRow(tx, input.clubId);
		if (!input.enabled && club.defaultTemplateId === input.templateId) {
			throw new Error(DISABLE_DEFAULT_MESSAGE);
		}
		const [updated] = await tx
			.update(meetingTemplates)
			.set({ enabled: input.enabled })
			.where(ownedBy(input.clubId, input.templateId))
			.returning({ id: meetingTemplates.id });
		if (!updated) throw new Error(CLUB_TEMPLATE_GONE_MESSAGE);
	});
}

/**
 * Delete a club template. `wasDefault` says the club is back on the standard
 * agenda for new meetings: the FK's ON DELETE SET NULL clears the pointer.
 *
 * Meetings that APPLIED the template hold their own private copies and are
 * untouched. The rare meeting still pointing at the row itself (data from
 * before private copies) is forked onto one first (`forkLegacyPointers`, as
 * #909's replace does), because `meetings.template_id` is ON DELETE RESTRICT
 * and because deleting its agenda out from under it is not what "delete a
 * template" means.
 *
 * Ownership is checked BEFORE the fork, not only in the DELETE: the fork
 * re-points every meeting reading the row, whatever its club, so running it
 * for a global template's id would fork other clubs' meetings.
 */
export async function deleteClubTemplate(input: {
	clubId: string;
	templateId: string;
}): Promise<{ wasDefault: boolean }> {
	return database.transaction(async (tx) => {
		const club = await lockClubRow(tx, input.clubId);
		const [owned] = await tx
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(ownedBy(input.clubId, input.templateId))
			.limit(1);
		if (!owned) throw new Error(CLUB_TEMPLATE_GONE_MESSAGE);
		await forkLegacyPointers(tx, owned.id);
		const [deleted] = await tx
			.delete(meetingTemplates)
			.where(ownedBy(input.clubId, input.templateId))
			.returning({ id: meetingTemplates.id });
		if (!deleted) throw new Error(CLUB_TEMPLATE_GONE_MESSAGE);
		return { wasDefault: club.defaultTemplateId === input.templateId };
	});
}

// ---------------------------------------------------------------------------
// The default agenda
// ---------------------------------------------------------------------------

/** A meeting named in a set-default result. */
export type MeetingRef = { meetingId: string; scheduledAt: Date };

/**
 * What setting a default did to the club's upcoming meetings (spec D4, D12).
 * Every scheduled meeting from now on lands in exactly one list.
 */
export type SetDefaultResult = {
	templateId: string | null;
	/** Now on a private copy of the default. */
	applied: MeetingRef[];
	/** Kept their own agenda. `onDefaultCopy` when that agenda is already a
	 *  copy of this default (a re-run of Set default), which the page words as
	 *  "already on a copy" rather than "kept its own edited agenda". */
	keptEdited: (MeetingRef & { onDefaultCopy: boolean })[];
	/** Still standard, but applying would release a sign-up or drop a
	 *  speech. `roles` names what the default does not include. */
	keptSignups: (MeetingRef & { roles: string[] })[];
	/** Still standard, and nobody would lose a role, but applying would
	 *  DELETE a slot the meeting has — a role the default does not include,
	 *  open today. `roles` names them. Never converted silently. */
	keptRoles: (MeetingRef & { roles: string[] })[];
	/** Something else went wrong on that one meeting; the loop went on. */
	failed: MeetingRef[];
};

/** Nothing applied — what clearing the default returns. */
function emptyResult(templateId: string | null): SetDefaultResult {
	return {
		templateId,
		applied: [],
		keptEdited: [],
		keptSignups: [],
		keptRoles: [],
		failed: [],
	};
}

/**
 * Set, or clear (`templateId: null`), the club's default agenda.
 *
 * SETTING writes `clubs.default_template_id` first, in its own transaction —
 * the target must be an ENABLED club-owned row of THIS club, checked in the
 * UPDATE's own WHERE — and then applies the default to every upcoming meeting
 * still on the standard agenda, one meeting per transaction
 * (`applyDefaultToUpcoming`). A failure on one meeting is reported and the
 * loop goes on; the default stays set either way, and running it again is
 * safe.
 *
 * CLEARING touches no meeting. New meetings go back to the standard agenda.
 */
export async function setClubDefaultTemplate(input: {
	clubId: string;
	templateId: string | null;
	actorMemberId: string | null;
}): Promise<SetDefaultResult> {
	const { clubId, templateId } = input;
	await database.transaction(async (tx) => {
		await lockClubRow(tx, clubId);
		if (templateId === null) {
			await tx
				.update(clubs)
				.set({ defaultTemplateId: null })
				.where(eq(clubs.id, clubId));
			return;
		}
		const [updated] = await tx
			.update(clubs)
			.set({ defaultTemplateId: templateId })
			.where(
				and(
					eq(clubs.id, clubId),
					// The tenant boundary, IN the write: the FK alone would accept
					// any template row at all.
					exists(
						tx
							.select({ one: sql`1` })
							.from(meetingTemplates)
							.where(
								and(
									ownedBy(clubId, templateId),
									eq(meetingTemplates.enabled, true),
								),
							),
					),
				),
			)
			.returning({ id: clubs.id });
		if (updated) return;
		// Only to choose the sentence; nothing was written.
		const [disabled] = await tx
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(ownedBy(clubId, templateId))
			.limit(1);
		throw new Error(
			disabled ? CLUB_TEMPLATE_DISABLED_MESSAGE : CLUB_TEMPLATE_GONE_MESSAGE,
		);
	});
	const result =
		templateId === null
			? emptyResult(null)
			: await applyDefaultToUpcoming(clubId, templateId);
	await logDefaultSet(clubId, input.actorMemberId, result);
	return result;
}

/**
 * Create a club template from the standard agenda AND make it the default, in
 * one action (spec Q3 / D13), then apply it like any newly set default.
 *
 * ONE transaction for the adoption itself, under the club lock: refuse if a
 * default is already set, insert the template, set the default. Two officers
 * adopting at once therefore make one template, and the second is refused.
 * Only after it commits does the meeting loop run, outside it.
 *
 * The template is the standard agenda exactly as it would materialise for
 * this club NOW (`standardAgendaForClub`): the same beats, so day one prints
 * the same sheet (22 beats, 23 on the GE variant, plus the five bands), and
 * the same role build (`declaredRolesForSeeds`), which declares every role the
 * club runs — so new meetings on the adopted default get the slots a standard
 * meeting gets today, functionaries included.
 */
export async function adoptStandardAgenda(input: {
	clubId: string;
	actorMemberId: string | null;
}): Promise<SetDefaultResult> {
	const { clubId } = input;
	const templateId = await database.transaction(async (tx) => {
		const club = await lockClubRow(tx, clubId);
		if (club.defaultTemplateId !== null) {
			throw new Error(ALREADY_ADOPTED_MESSAGE);
		}
		const standard = await standardAgendaForClub(tx, clubId);
		if (!standard) throw new Error("Club not found.");

		const key = await nextClubTemplateKey(tx, clubId, ADOPTED_TEMPLATE_KEY);
		const [created] = await tx
			.insert(meetingTemplates)
			.values({
				clubId,
				meetingId: null,
				key,
				name: ADOPTED_TEMPLATE_NAME,
				description: null,
				sortOrder: 0,
				enabled: true,
			})
			.returning({ id: meetingTemplates.id });
		if (!created) throw new Error("Failed to create the club's agenda.");
		await tx
			.insert(meetingTemplateBeats)
			.values(
				standard.seeds.map((seed) => ({ ...seed, templateId: created.id })),
			);
		if (standard.roles.length > 0) {
			await tx
				.insert(meetingTemplateRoles)
				.values(
					standard.roles.map((role) => ({ ...role, templateId: created.id })),
				);
		}
		await tx
			.update(clubs)
			.set({ defaultTemplateId: created.id })
			.where(eq(clubs.id, clubId));
		return created.id;
	});
	const result = await applyDefaultToUpcoming(clubId, templateId);
	await logDefaultSet(clubId, input.actorMemberId, result);
	return result;
}

/**
 * Apply the default to each upcoming meeting still on the standard agenda,
 * where doing so deletes no slot at all — so releases no claimed role, drops
 * no speech (spec D4, Q2), and takes no open role off the meeting (#910).
 *
 * Candidates: this club's `scheduled` meetings from now on, soonest first.
 * "Still on the standard agenda" is `template_id IS NULL`, or the meeting's
 * own private copy keyed `meeting-<id>` whose content equals what the standard
 * would materialise for the club NOW (`agendaMatchesStandard`) — opening the
 * editor materialises a copy, and a copy nobody touched is not an edit.
 *
 * Per meeting, a pre-plan (`planTemplateConversion`) skips the obvious
 * releases cheaply; the conversion itself re-checks under the meeting's lock
 * (`refuseIfReleasing`, `refuseIfRemoving`): a `WouldReleaseError` lands the
 * meeting in `keptSignups` and a `WouldRemoveError` in `keptRoles`, exactly
 * as the pre-plan would have. Each conversion is its own transaction, so one meeting's
 * failure never undoes another's.
 */
async function applyDefaultToUpcoming(
	clubId: string,
	templateId: string,
): Promise<SetDefaultResult> {
	const result = emptyResult(templateId);
	const [standard, [target], candidates] = await Promise.all([
		standardAgendaForClub(database, clubId),
		database
			.select({ key: meetingTemplates.key })
			.from(meetingTemplates)
			.where(ownedBy(clubId, templateId))
			.limit(1),
		database
			.select({
				id: meetings.id,
				scheduledAt: meetings.scheduledAt,
				templateId: meetings.templateId,
			})
			.from(meetings)
			.where(
				and(
					eq(meetings.clubId, clubId),
					eq(meetings.status, "scheduled"),
					gte(meetings.scheduledAt, new Date()),
				),
			)
			.orderBy(asc(meetings.scheduledAt)),
	]);
	if (!standard) return result;
	const expected: ComparableAgenda = {
		beats: standard.seeds,
		roles: standard.roles,
	};

	for (const [index, meeting] of candidates.entries()) {
		const ref: MeetingRef = {
			meetingId: meeting.id,
			scheduledAt: meeting.scheduledAt,
		};
		try {
			const copy =
				meeting.templateId === null
					? null
					: await loadComparableCopy(database, meeting.id, meeting.templateId);
			const standardNow =
				meeting.templateId === null ||
				(copy !== null &&
					copy.key === privateCopyKey(meeting.id) &&
					agendaMatchesStandard(copy, expected));
			if (!standardNow) {
				result.keptEdited.push({
					...ref,
					onDefaultCopy: copy !== null && copy.key === target?.key,
				});
				continue;
			}
			const plan = await planTemplateConversion(meeting.id, templateId);
			if (releasesAnything(plan)) {
				result.keptSignups.push({ ...ref, roles: plan.releasedRoleNames });
				continue;
			}
			if (removesAnything(plan)) {
				result.keptRoles.push({ ...ref, roles: plan.removedRoleNames });
				continue;
			}
			await applyTemplateConversion({
				meetingId: meeting.id,
				clubId,
				templateId,
				actorMemberId: null,
				refuseIfReleasing: true,
				refuseIfRemoving: true,
				// Re-checked under the lock: still the pointer we compared, still
				// standard, still the club's default, club still open.
				expectStandard: { templateId: meeting.templateId, standard: expected },
			});
			result.applied.push(ref);
		} catch (err) {
			if (err instanceof ApplyPreconditionError) {
				if (err.reason === "edited") {
					result.keptEdited.push({ ...ref, onDefaultCopy: false });
					continue;
				}
				// The club was archived mid-loop: this meeting and every one
				// after it is reported as failed and the loop stops — the gate
				// every other write honours, seen as soon as it commits.
				if (err.reason === "archived") {
					for (const rest of candidates.slice(index)) {
						result.failed.push({
							meetingId: rest.id,
							scheduledAt: rest.scheduledAt,
						});
					}
					return result;
				}
				// Superseded: another officer set or cleared the default since
				// this one did. Stop applying the stale default, and list the
				// remaining meetings nowhere — they belong to the newer call's
				// own result, which ran its own loop over them.
				return result;
			}
			if (err instanceof WouldReleaseError) {
				result.keptSignups.push({
					...ref,
					roles: err.plan.releasedRoleNames,
				});
			} else if (err instanceof WouldRemoveError) {
				result.keptRoles.push({ ...ref, roles: err.plan.removedRoleNames });
			} else {
				result.failed.push(ref);
			}
		}
	}
	return result;
}

/** One activity row per set-default or adoption, with the five counts. */
async function logDefaultSet(
	clubId: string,
	actorMemberId: string | null,
	result: SetDefaultResult,
): Promise<void> {
	await logActivity(database, {
		clubId,
		actorMemberId,
		action: "club_default_template_set",
		targetType: "club",
		targetId: clubId,
		detail: {
			templateId: result.templateId,
			applied: result.applied.length,
			keptEdited: result.keptEdited.length,
			keptSignups: result.keptSignups.length,
			keptRoles: result.keptRoles.length,
			failed: result.failed.length,
		},
	});
}

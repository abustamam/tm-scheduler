// Speaker-slot management DB logic, split out from `slots.ts` (a createServerFn
// module the guard test forbids from exporting db-touching functions).
// Integration-testable by mocking `#/db`.
import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { db } from "#/db";
import {
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	pairedRoleIds,
	pickSpeakerAndEvaluatorRoles,
	type SpeakerEvaluatorRoles,
} from "#/lib/meeting-roles";
import { normalizePresentationUrl } from "#/lib/presentation-url";
import { isRealSpeechTitle, TBA_SPEECH_TITLE } from "#/lib/speech-title";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import { logActivity } from "./activity";
import { setPlanStatus } from "./attendance-plan-logic";
import { assertClubNotArchived, requireClubRole } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import { loadMeetingShapeDefs, roleDefScope } from "./meeting-templates-logic";
import { resolveProjectDisplay } from "./project-picker-logic";

// Either the main db client or a drizzle transaction — so speech helpers can run
// inside a caller's transaction and commit atomically with the slot change.
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** The club's resolved speaker/evaluator role ids, plus whether each is
 *  currently `enabled` (#368) — a disabled role must never be reintroduced by
 *  the "+ Add speaker" path, which `applyAddSpeakerSlot` below enforces using
 *  these flags. `evaluatorEnabled` is false (not just absent) when the club has
 *  no paired evaluator role at all, which is the safe default for a caller
 *  that only checks the flag before inserting. */
async function clubRoles(
	clubId: string,
	templateId: string | null,
): Promise<
	SpeakerEvaluatorRoles & { speakerEnabled: boolean; evaluatorEnabled: boolean }
> {
	// Scoped to the MEETING's SHAPE, never the whole bank. Over the union, a
	// contest meeting's "+ Add speaker" resolves through
	// `pickSpeakerAndEvaluatorRoles`, which takes the lowest `sortOrder` speaker
	// role — the club's standard Speaker — and adds a slot that renders nowhere
	// on the contest sheet, leaving no in-product way to change the contestant
	// count. The mirror case is what makes `standing` load-bearing on the
	// STANDARD arm since #801: the bank now holds the contest's own roles too,
	// so without it a promoted Contestant is a candidate on every ordinary
	// meeting. A union is wrong in both directions; it is not an optimisation
	// this could take.
	const defs = await loadMeetingShapeDefs(db, clubId, templateId);
	const picked = pickSpeakerAndEvaluatorRoles(defs);
	const enabledOf = (id: string | null) =>
		id ? (defs.find((d) => d.id === id)?.enabled ?? false) : false;
	return {
		...picked,
		speakerEnabled: enabledOf(picked.speakerRoleId),
		evaluatorEnabled: enabledOf(picked.evaluatorRoleId),
	};
}

/** Next 0-based slotIndex for a (meeting, role) pair. */
function nextIndex(indices: number[]): number {
	return indices.length === 0 ? 0 : Math.max(...indices) + 1;
}

/**
 * The numbering read, taken on the caller's transaction — which is the whole
 * point of it being one function. "What is the next index" is a DECISION, not a
 * lookup, so it is only correct while `lockMeetingForSlotEdit` holds the meeting
 * row; computed on a pre-transaction snapshot, two concurrent adds resolve the
 * same answer and both insert it, and nothing in the database says no
 * (`role_slots` constrains only `speech_id`). Both add paths route through here
 * so there is ONE place where "read under the lock" is true or false.
 *
 * What is load-bearing is the ORDER — this call must come after the caller's
 * `lockMeetingForSlotEdit`, because that is the statement that parks a second
 * writer. Passing `db` instead of `tx` from that position measures the same on
 * `tm_test` (READ COMMITTED gives the other connection a post-commit snapshot
 * too), so the type is the cheap half; the placement is the half a reader has
 * to check, and `role-slot-index-lock.integration.test.ts` is what checks it.
 */
async function nextIndexUnderLock(
	tx: DbOrTx,
	meetingId: string,
	roleDefinitionId: string,
): Promise<number> {
	const existing = await tx
		.select({ slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.roleDefinitionId, roleDefinitionId),
			),
		);
	return nextIndex(existing.map((s) => s.slotIndex));
}

/** Add one Speaker slot (+ a paired Evaluator slot, count-parity). Reached from
 *  a PUBLIC, no-session path (a self-asserted TMOD, see `requireMeetingAgendaEditor`
 *  in `guards.ts`), so it must independently enforce `enabled` (#368) — the roles
 *  admin toggle already clears a disabled role's open slots from upcoming
 *  meetings, and this is the one place a public caller could otherwise put one
 *  right back. Rejects outright when the club's Speaker role is disabled (there's
 *  nothing sensible to add); silently skips the Evaluator insert when only the
 *  paired Evaluator role is disabled (the Speaker slot alone is still useful). */
export async function applyAddSpeakerSlot(input: {
	meetingId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const { speakerRoleId, evaluatorRoleId, speakerEnabled, evaluatorEnabled } =
		await clubRoles(meeting.clubId, meeting.templateId);
	if (!speakerEnabled) {
		throw new Error("This club's Speaker role is currently disabled.");
	}

	await db.transaction(async (tx) => {
		await lockMeetingForSlotEdit(tx, input.meetingId);
		// BOTH numbering reads happen here, before either insert, so neither index
		// is derived from a row this same call just wrote. A null evaluator index
		// IS the "skip the evaluator insert" decision — the disabled-paired-role
		// case (#368) — so the insert below gates on it rather than re-testing
		// `evaluatorEnabled` and leaving two places that could disagree.
		const speakerIndex = await nextIndexUnderLock(
			tx,
			input.meetingId,
			speakerRoleId,
		);
		const evaluatorIndex =
			evaluatorRoleId && evaluatorEnabled
				? await nextIndexUnderLock(tx, input.meetingId, evaluatorRoleId)
				: null;
		// `returning` so the evaluator can point at this speaker (#512). The pair
		// is already established here — the "+ Add speaker" button creates both
		// rows in this one transaction — but until now the link was never written
		// down, so `role_slots.evaluates_slot_id` was NULL on every meeting made
		// through the app and five readers of it silently did nothing.
		const [speaker] = await tx
			.insert(roleSlots)
			.values({
				meetingId: input.meetingId,
				roleDefinitionId: speakerRoleId,
				slotIndex: speakerIndex,
			})
			.returning({ id: roleSlots.id });
		if (evaluatorRoleId && evaluatorIndex !== null) {
			await tx.insert(roleSlots).values({
				meetingId: input.meetingId,
				roleDefinitionId: evaluatorRoleId,
				slotIndex: evaluatorIndex,
				// The realign below re-points every link positionally anyway; writing
				// the pair here keeps the insert self-consistent on its own.
				evaluatesSlotId: speaker.id,
			});
		}
		// Positional pairing: heal any drifted links (a crossed legacy meeting
		// fixes itself on its next edit) and keep numbering dense.
		await realignEvaluatorPairs(
			tx,
			input.meetingId,
			speakerRoleId,
			evaluatorRoleId,
		);
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { change: "speaker_added" },
		});
	});
	return { clubId: meeting.clubId };
}

/** The club's whole role BANK in the shape `pairedRoleIds` needs, plus
 *  name/id/enabled/standing.
 *
 *  The ATTACHABLE set, which since #801 is no longer the same question as "what
 *  is this meeting made of" (`loadMeetingShapeDefs`). It deliberately carries
 *  non-standing rows: attaching the club's own Timer to a special meeting is
 *  the reported bug, and a contest role an officer wants on a second contest is
 *  the same request from the other side. `standing` gates AUTO-GENERATION, not
 *  what a person may choose on purpose. */
async function clubRoleDefs(conn: DbOrTx, clubId: string) {
	return conn
		.select({
			id: roleDefinitions.id,
			name: roleDefinitions.name,
			category: roleDefinitions.category,
			defaultCount: roleDefinitions.defaultCount,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			enabled: roleDefinitions.enabled,
			standing: roleDefinitions.standing,
		})
		.from(roleDefinitions)
		.where(roleDefScope(clubId));
}

/** Add one open slot of an arbitrary non-paired role to a meeting. Duplicates
 *  allowed (next slotIndex). Rejects the speaker/paired-evaluator roles (those
 *  go through the +/- speaker buttons) and roles from another club.
 *
 *  TWO different role sets, and that is the whole of #801's read-side fix. The
 *  ATTACHABLE set is the club's bank, so a meeting on a custom agenda can reach
 *  its own club's Timer — it could not before, because one either/or predicate
 *  answered both questions and this call simply threw "Role not found for this
 *  club." The PAIRED set is the meeting's declared shape, so "add speakers with
 *  the speaker controls" still names the right pair on a contest (Contestant)
 *  and on an ordinary meeting (Speaker).
 *
 *  Rejects on `enabled`, never on `standing`: a non-standing role is one the
 *  club is not scheduled to run by default, not one it has turned off. */
export async function applyAddRoleSlot(input: {
	meetingId: string;
	roleDefinitionId: string;
	actorMemberId: string | null;
}) {
	return db.transaction(async (tx) => {
		// THE LOCK COMES FIRST, and every gate below reads the row it returns
		// (#803, review). Numbering was only half of what was racing here: two of
		// the checks are themselves meeting-ROW reads, and both decide whether the
		// insert may happen at all.
		//
		// `status` is the plain one — under READ COMMITTED a concurrent "complete
		// meeting" commits between an unlocked read of it and this insert, and the
		// slot lands on a completed meeting. `templateId` is the quieter one: it
		// picks the meeting's declared SHAPE, and the shape is what decides whether
		// this role is a paired speaker/evaluator role the "+ Add role" path must
		// refuse. Converting a meeting to a template that calls this role a
		// Contestant, committed in that same window, admits a slot the speaker
		// controls own.
		//
		// The one read here the lock does NOT govern is `clubRoleDefs` — the club's
		// role bank is club-scoped and no meeting row decides it. It runs on `tx`
		// for one snapshot rather than because it needs the lock.
		const meeting = await lockMeetingForSlotEdit(tx, input.meetingId);
		assertMeetingNotLocked(meeting.status);

		const defs = await clubRoleDefs(tx, meeting.clubId);
		const role = defs.find((d) => d.id === input.roleDefinitionId);
		if (!role) throw new Error("Role not found for this club.");
		if (!role.enabled) throw new Error("This role is currently disabled.");
		const shape = await loadMeetingShapeDefs(
			tx,
			meeting.clubId,
			meeting.templateId,
		);
		if (pairedRoleIds(shape).has(role.id)) {
			throw new Error("Add speakers with the speaker controls.");
		}

		const slotIndex = await nextIndexUnderLock(
			tx,
			input.meetingId,
			input.roleDefinitionId,
		);
		await tx.insert(roleSlots).values({
			meetingId: input.meetingId,
			roleDefinitionId: input.roleDefinitionId,
			slotIndex,
		});
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: {
				change: "role_added",
				roleDefinitionId: input.roleDefinitionId,
			},
		});
		return { clubId: meeting.clubId };
	});
}

/** Remove one unclaimed, non-paired slot from a meeting. Rejects a claimed slot
 *  (never destroys an assignment) and the speaker/paired-evaluator roles. */
export async function applyRemoveRoleSlot(input: {
	slotId: string;
	actorMemberId: string | null;
}) {
	const [slot] = await db
		.select({
			id: roleSlots.id,
			meetingId: roleSlots.meetingId,
			roleDefinitionId: roleSlots.roleDefinitionId,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			clubId: meetings.clubId,
			templateId: meetings.templateId,
			meetingStatus: meetings.status,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, input.slotId))
		.limit(1);
	if (!slot) throw new Error("Role not found.");
	assertMeetingNotLocked(slot.meetingStatus);
	if (slot.assignedMemberId || slot.status !== "open") {
		throw new Error("Release the role before removing it.");
	}

	// The meeting's declared SHAPE, matching `applyAddRoleSlot`'s paired check —
	// the two have to name the same pair or a role becomes addable but not
	// removable.
	const shape = await loadMeetingShapeDefs(db, slot.clubId, slot.templateId);
	if (pairedRoleIds(shape).has(slot.roleDefinitionId)) {
		throw new Error("Remove speakers with the speaker controls.");
	}

	await db.transaction(async (tx) => {
		await tx.delete(roleSlots).where(eq(roleSlots.id, input.slotId));
		await logActivity(tx, {
			clubId: slot.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: slot.meetingId,
			detail: {
				change: "role_removed",
				roleDefinitionId: slot.roleDefinitionId,
			},
		});
	});
	return { clubId: slot.clubId };
}

/** `detail.change` values `backfillMissingRoleSlots` can log — a plain `string`
 *  param would let a typo degrade silently through `logActivity`'s untyped
 *  `detail` into `formatActivity`'s switch (`#/lib/activity-format.ts`), which
 *  falls back to "updated the meeting" for anything it doesn't recognize. */
type BackfillChangeLabel = "template_sync" | "role_enabled";

/** For each of `meetingIds`, add one open slot of each of `defs` the meeting
 *  doesn't already have any slot for. Never tops up an existing role's count
 *  toward its `defaultCount` — presence-based, not count-based (a naive
 *  count-based top-up would fight a club that intentionally removed a slot).
 *  Shared "add missing slots" walk behind both the "Update upcoming meetings
 *  to match" admin action and the role enable-toggle backfill (#368). Returns
 *  how many meetings changed and the distinct role names added.
 *
 *  `standing AND enabled` is enforced HERE rather than at the two callers, and
 *  that placement is the whole point (#801). Before, a contest role could not
 *  reach an ordinary meeting through either caller because `roleDefScope`'s
 *  template axis excluded it three layers up; now the bank holds every role and
 *  `standing` is the only thing between a promoted Chief Judge and an open slot
 *  on every upcoming meeting. One gate at the one statement that writes, not
 *  two predicates at two call sites that can drift. */
async function backfillMissingRoleSlots(input: {
	clubId: string;
	meetingIds: string[];
	defs: { id: string; name: string; standing: boolean; enabled: boolean }[];
	actorMemberId: string | null;
	changeLabel: BackfillChangeLabel;
}): Promise<{ meetingsChanged: number; rolesAdded: string[] }> {
	const rolesAdded = new Set<string>();
	let meetingsChanged = 0;
	const defs = input.defs.filter((d) => d.standing && d.enabled);
	if (defs.length === 0) return { meetingsChanged: 0, rolesAdded: [] };

	await db.transaction(async (tx) => {
		for (const meetingId of input.meetingIds) {
			const present = await tx
				.select({ roleDefinitionId: roleSlots.roleDefinitionId })
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, meetingId));
			const presentIds = new Set(present.map((s) => s.roleDefinitionId));
			const missing = defs.filter((d) => !presentIds.has(d.id));
			if (missing.length === 0) continue;

			await tx.insert(roleSlots).values(
				missing.map((d) => ({
					meetingId,
					roleDefinitionId: d.id,
					slotIndex: 0,
				})),
			);
			for (const d of missing) rolesAdded.add(d.name);
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId,
				action: "meeting_edit",
				targetType: "meeting",
				targetId: meetingId,
				detail: {
					change: input.changeLabel,
					roleDefinitionIds: missing.map((d) => d.id),
				},
			});
			meetingsChanged += 1;
		}
	});

	return { meetingsChanged, rolesAdded: [...rolesAdded] };
}

/** Presence-based template backfill: for every upcoming meeting (scheduledAt >
 *  now), add one open slot of each standard (`enabled`, `defaultCount >= 1`),
 *  non-paired role the meeting has zero of. Never tops up counts, never adds
 *  speakers/paired evaluators, never touches past meetings. Idempotent. Backs
 *  the roles admin page's "Update upcoming meetings to match" button. */
export async function applyTemplateSyncToUpcomingMeetings(input: {
	clubId: string;
	actorMemberId: string | null;
}) {
	// The club's STANDARD shape, which is what "update upcoming meetings to
	// match" means. `loadMeetingShapeDefs(…, null)` filters `standing`, so a
	// contest role promoted into the bank (#801) is not a candidate here — the
	// regression this button is closest to causing, since `roleDefScope`'s
	// template axis used to be the only thing holding it out.
	const defs = await loadMeetingShapeDefs(db, input.clubId, null);
	const paired = pairedRoleIds(defs);
	// `enabled` matters here (#368): without it, disabling a role (e.g.
	// Ah-Counter) and then clicking this button would re-add it to every
	// upcoming meeting — exactly the workflow the toggle exists to prevent.
	// `backfillMissingRoleSlots` re-applies both flags at the write itself.
	const standard = defs.filter(
		(d) => d.defaultCount >= 1 && d.enabled && !paired.has(d.id),
	);

	// Deliberately does NOT exclude cancelled meetings, unlike the enable-toggle
	// path below (`futureNonCancelledMeetingIds`): that's a #368 addition and
	// this pre-existing query's behavior toward cancelled meetings was out of
	// scope to change without its own dedicated test — this comment documents
	// the divergence is intentional, not an oversight.
	const upcoming = await db
		.select({ id: meetings.id })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, input.clubId),
				gt(meetings.scheduledAt, new Date()),
				// TEMPLATED meetings are not the club's standard shape. Backfilling
				// them would inject Timer/Grammarian/Ah-Counter into every future
				// contest.
				isNull(meetings.templateId),
			),
		);

	return backfillMissingRoleSlots({
		clubId: input.clubId,
		meetingIds: upcoming.map((m) => m.id),
		defs: standard,
		actorMemberId: input.actorMemberId,
		changeLabel: "template_sync",
	});
}

/** Ids of a club's meetings scheduled in the future (`scheduledAt > now`) that
 *  are not cancelled. Used by the role enable/disable toggle (#368): past
 *  meetings are the club's history and cancelled ones aren't going to run, so
 *  neither should gain or lose slots when a role's `enabled` flag flips. */
async function futureNonCancelledMeetingIds(clubId: string): Promise<string[]> {
	const rows = await db
		.select({ id: meetings.id })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				gt(meetings.scheduledAt, new Date()),
				ne(meetings.status, "cancelled"),
				// TEMPLATED meetings are not the club's standard shape. Enabling or
				// disabling a standard role must not add or remove slots on a
				// contest, whose role set comes from its template.
				isNull(meetings.templateId),
			),
		);
	return rows.map((r) => r.id);
}

/** Delete a role's OPEN, UNCLAIMED slots across `meetingIds`, atomically. A
 *  slot counts as claimed — and is never deleted — if it has an assigned
 *  member OR an assigned guest; silently un-assigning someone who volunteered
 *  is the one genuinely bad outcome a disable could cause.
 *
 *  The "unclaimed" predicate is embedded directly in the DELETE's WHERE clause
 *  rather than decided by a separate SELECT beforehand: `claimSlot` is a
 *  PUBLIC, no-session server fn (`src/server/slots.ts`), so a read-then-delete
 *  split has a window where a claim lands in between and gets destroyed anyway
 *  — exactly the outcome this function promises never happens. Postgres
 *  evaluates a DELETE's WHERE clause against each row's current (lock-waited,
 *  post-commit) state, so a concurrent claim either commits first (the row no
 *  longer matches `assignedMemberId/assignedGuestId IS NULL` and survives) or
 *  loses the row lock race entirely — there is no gap. Same idea as
 *  `claimSlot`'s own "conditional UPDATE is the race guard" and
 *  `reassignSlotCore`'s `FOR UPDATE` lock.
 *
 *  Returns how many of those meetings had a slot deleted, and how many kept at
 *  least one claimed slot for the role — read via a follow-up SELECT inside
 *  the SAME transaction as the delete (any row still present afterward is, by
 *  construction, claimed) so the count can't be skewed by anything that
 *  commits after this transaction does. */
async function removeOpenRoleSlots(
	meetingIds: string[],
	roleDefinitionId: string,
	clubId: string,
	actorMemberId: string | null,
): Promise<{ keptClaimedMeetings: number; meetingsChanged: number }> {
	if (meetingIds.length === 0) {
		return { keptClaimedMeetings: 0, meetingsChanged: 0 };
	}

	return db.transaction(async (tx) => {
		const deleted = await tx
			.delete(roleSlots)
			.where(
				and(
					inArray(roleSlots.meetingId, meetingIds),
					eq(roleSlots.roleDefinitionId, roleDefinitionId),
					isNull(roleSlots.assignedMemberId),
					isNull(roleSlots.assignedGuestId),
				),
			)
			.returning({ id: roleSlots.id, meetingId: roleSlots.meetingId });

		const affectedMeetings = [...new Set(deleted.map((d) => d.meetingId))];
		for (const meetingId of affectedMeetings) {
			await logActivity(tx, {
				clubId,
				actorMemberId,
				action: "meeting_edit",
				targetType: "meeting",
				targetId: meetingId,
				detail: {
					change: "role_disabled",
					roleDefinitionIds: [roleDefinitionId],
				},
			});
		}

		// Anything still present for this role on these meetings, post-delete, is
		// necessarily claimed — we just deleted every unclaimed row. Reading this
		// inside the same transaction keeps it consistent with the delete above.
		const remaining = await tx
			.select({ meetingId: roleSlots.meetingId })
			.from(roleSlots)
			.where(
				and(
					inArray(roleSlots.meetingId, meetingIds),
					eq(roleSlots.roleDefinitionId, roleDefinitionId),
				),
			);
		const keptClaimedMeetings = new Set(remaining.map((r) => r.meetingId)).size;

		return { keptClaimedMeetings, meetingsChanged: affectedMeetings.length };
	});
}

/** Slot side effects when a role definition's `enabled` flag flips (#368):
 *  a "skeleton crew" club turning a role off shouldn't have to manually clean
 *  up every future meeting, and turning it back on shouldn't require a
 *  separate trip to "Update upcoming meetings to match".
 *
 *  - Disabling removes the role's open, unclaimed slots from future,
 *    non-cancelled meetings — never a claimed one (see `removeOpenRoleSlots`).
 *  - Enabling backfills one open slot onto every future, non-cancelled meeting
 *    that currently has none for this role — but ONLY for a non-paired role.
 *    The Speaker role and its paired Evaluator are managed exclusively by the
 *    "+ / − speaker" controls (`applyAddSpeakerSlot`/`applyRemoveSpeakerSlot`),
 *    which always add/remove them together to keep count-parity; backfilling a
 *    bare Speaker slot here with no matching Evaluator would break that
 *    invariant on every future meeting. This is a no-op for a paired role,
 *    mirroring `applyTemplateSyncToUpcomingMeetings`'s own `!paired.has(d.id)`
 *    exclusion from its "standard" backfill set. For a non-paired role, this
 *    still never tops up toward `defaultCount` (presence-based, like that same
 *    function) and is skipped entirely when `defaultCount` is 0.
 *  - Past and cancelled meetings are never touched either way.
 *
 *  Returns `keptClaimedMeetings` (upcoming meetings that still have the role
 *  assigned to someone — always 0 when enabling) and `meetingsChanged` +
 *  `rolesAdded` (0 / `[]` when disabling, or when enabling was a no-op) so the
 *  caller can build an informative toast either way. */
export async function syncSlotsForRoleEnabledChange(input: {
	clubId: string;
	roleDefinitionId: string;
	roleName: string;
	defaultCount: number;
	enabled: boolean;
	/** `role_definitions.standing` (#801). A NON-standing role is not part of
	 *  the club's standard meeting shape, so enabling it must backfill nothing:
	 *  `enabled` says "the club still runs this role", `standing` says "on every
	 *  ordinary meeting", and only the second is a claim about upcoming
	 *  agendas. Passed in by the caller, which has already read the row. */
	standing: boolean;
	actorMemberId: string | null;
}): Promise<{
	keptClaimedMeetings: number;
	meetingsChanged: number;
	rolesAdded: string[];
}> {
	const meetingIds = await futureNonCancelledMeetingIds(input.clubId);
	if (meetingIds.length === 0) {
		return { keptClaimedMeetings: 0, meetingsChanged: 0, rolesAdded: [] };
	}

	if (!input.enabled) {
		const result = await removeOpenRoleSlots(
			meetingIds,
			input.roleDefinitionId,
			input.clubId,
			input.actorMemberId,
		);
		return { ...result, rolesAdded: [] };
	}

	const defs = await loadMeetingShapeDefs(db, input.clubId, null);
	const isPaired = pairedRoleIds(defs).has(input.roleDefinitionId);
	if (isPaired || input.defaultCount < 1) {
		return { keptClaimedMeetings: 0, meetingsChanged: 0, rolesAdded: [] };
	}

	const result = await backfillMissingRoleSlots({
		clubId: input.clubId,
		meetingIds,
		defs: [
			{
				id: input.roleDefinitionId,
				name: input.roleName,
				standing: input.standing,
				enabled: true,
			},
		],
		actorMemberId: input.actorMemberId,
		changeLabel: "role_enabled",
	});
	return { keptClaimedMeetings: 0, ...result };
}

/** Highest-index unclaimed (open, unassigned) slot id for a role, or null. */
function topUnclaimed(
	slots: {
		id: string;
		slotIndex: number;
		status: string;
		assignedMemberId: string | null;
	}[],
	roleId: string,
	roleOf: (id: string) => string,
): string | null {
	const open = slots
		.filter(
			(s) =>
				roleOf(s.id) === roleId && s.status === "open" && !s.assignedMemberId,
		)
		.sort((a, b) => b.slotIndex - a.slotIndex);
	return open[0]?.id ?? null;
}

/** Remove one unclaimed Speaker slot together with the evaluator paired to THAT
 *  speaker (#512). */
export async function applyRemoveSpeakerSlot(input: {
	meetingId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const { speakerRoleId, evaluatorRoleId } = await clubRoles(
		meeting.clubId,
		meeting.templateId,
	);

	// Read under the meeting lock, like the add path: which slot is "the top
	// unclaimed one" and which evaluator is paired to it are DECISIONS, and a
	// concurrent add or reorder moves both answers.
	return db.transaction(async (tx) => {
		await lockMeetingForSlotEdit(tx, input.meetingId);
		const slots = await tx
			.select({
				id: roleSlots.id,
				roleDefinitionId: roleSlots.roleDefinitionId,
				slotIndex: roleSlots.slotIndex,
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				assignedGuestId: roleSlots.assignedGuestId,
				evaluatesSlotId: roleSlots.evaluatesSlotId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, input.meetingId));
		const roleOf = (id: string) =>
			slots.find((s) => s.id === id)?.roleDefinitionId ?? "";

		const speakerId = topUnclaimed(slots, speakerRoleId, roleOf);
		if (!speakerId)
			throw new Error("Release a speaker before removing a slot.");

		/**
		 * Remove the evaluator paired to THIS speaker, not the highest unclaimed one.
		 *
		 * Picking each role's top unclaimed slot independently looks equivalent and
		 * is not: the two picks diverge the moment a claimed speaker and a claimed
		 * evaluator sit at different positions. Proven case — Speaker 1 claimed,
		 * Evaluator 2 claimed:
		 *
		 *   before  Sp1 claimed · Sp2 open · Ev1 open→Sp1 · Ev2 claimed→Sp2
		 *   after   Sp2 and Ev1 deleted — so the removed speaker's OWN evaluator
		 *           (Ev2) survived pointing at nothing (the FK is ON DELETE SET
		 *           NULL), while an evaluator whose speaker is still present was
		 *           destroyed instead.
		 *
		 * The link only became available with #512; before it there was no way to
		 * know which evaluator belonged to which speaker, which is why the original
		 * picked by index.
		 */
		const claimed = (s: {
			status: string;
			assignedMemberId: string | null;
			assignedGuestId: string | null;
		}) => s.status !== "open" || !!s.assignedMemberId || !!s.assignedGuestId;

		const pairedEvaluator = evaluatorRoleId
			? slots.find(
					(s) =>
						s.roleDefinitionId === evaluatorRoleId &&
						s.evaluatesSlotId === speakerId,
				)
			: undefined;

		let evaluatorId: string | null;
		if (pairedEvaluator) {
			// Never destroy an assignment — the same stance as "Release the role
			// before removing it" and "Release a speaker before removing a slot".
			// Someone claimed this evaluator slot to evaluate THAT speaker; deleting
			// the speaker under them would leave them evaluating nobody, and they
			// would not find out until the agenda printed.
			if (claimed(pairedEvaluator)) {
				const speaker = slots.find((s) => s.id === speakerId);
				throw new Error(
					`Release the evaluator for Speaker ${(speaker?.slotIndex ?? 0) + 1} before removing that speaker.`,
				);
			}
			evaluatorId = pairedEvaluator.id;
		} else {
			// No recorded pairing: a meeting created before #512 and not backfilled,
			// or a club whose evaluator count never matched its speaker count. Fall
			// back to the historical behaviour rather than removing nothing.
			evaluatorId = evaluatorRoleId
				? topUnclaimed(slots, evaluatorRoleId, roleOf)
				: null;
		}
		await tx.delete(roleSlots).where(eq(roleSlots.id, speakerId));
		if (evaluatorId) {
			await tx.delete(roleSlots).where(eq(roleSlots.id, evaluatorId));
		}
		// Positional pairing: compact both roles' numbering (a mid-list evaluator
		// deletion otherwise leaves "Evaluator 1, Evaluator 3") and re-point the
		// surviving links so Evaluator N evaluates Speaker N.
		await realignEvaluatorPairs(
			tx,
			input.meetingId,
			speakerRoleId,
			evaluatorRoleId,
		);
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { change: "speaker_removed" },
		});
		return { clubId: meeting.clubId };
	});
}

/**
 * Serialize every slot mutation for one meeting on the MEETING row.
 *
 * The reads that decide numbering and pairing used to run on a pre-transaction
 * snapshot, which is not good enough once those reads DECIDE something: two
 * concurrent "+ Add speaker" calls each computed the same next `slot_index` and
 * both inserted it (no unique index stops them, measured as `[0, 1, 1]`), and a
 * reorder racing an add could compute evaluator targets from the pre-move order
 * and commit them afterwards — links silently describing an order the meeting no
 * longer has, which is the one thing positional pairing promises.
 *
 * The MEETING row rather than the slot rows, for two reasons: a slot edit
 * changes which slots exist, so there is no fixed row set to lock up front, and
 * one lock per meeting cannot deadlock the way two swap targets locked in
 * opposite orders can (two officers reordering the same lineup in opposite
 * directions was an AB-BA deadlock, surfacing as a 500).
 *
 * RETURNS THE LOCKED ROW, and a caller that gates on `status` or `templateId`
 * must read them from THAT copy rather than from one taken before the
 * transaction. Both columns live on this very row: under READ COMMITTED a
 * concurrent "complete meeting" or template change commits between an unlocked
 * read of them and the insert that follows, and the write then lands on a
 * meeting the gate it passed would now refuse. `mcp/tools/assign-roles.ts` takes
 * this same row `FOR UPDATE` to re-read `status` for exactly that reason.
 *
 * Does NOT serialize against `claimSlot`, which locks the slot row instead — see
 * TODOS.md for the remove-vs-claim window that leaves open.
 */
async function lockMeetingForSlotEdit(tx: DbOrTx, meetingId: string) {
	const [locked] = await tx
		.select({
			id: meetings.id,
			clubId: meetings.clubId,
			status: meetings.status,
			templateId: meetings.templateId,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.for("update")
		.limit(1);
	if (!locked) throw new Error("Meeting not found.");
	return locked;
}

/**
 * Positional pairing (Evaluator N ↔ Speaker N): renumber both paired roles'
 * slots densely (0..n-1, by current order) and point evaluator i at speaker i
 * (surplus evaluators at nothing). Runs inside every mutation that changes
 * either role's order or membership — add, remove, and both moves — so the
 * stored `evaluates_slot_id` never disagrees with the numbers on the cards.
 * A meeting left crossed by the old sticky-follows-the-person pairing heals on
 * its next edit; untouched meetings (past ones included) keep their history.
 *
 * NOTE THAT IT NEVER READS `evaluates_slot_id` — it OVERWRITES it, positionally,
 * from the two roles' sorted slot arrays. So the stored pointer is an output of
 * this function, not an input, and anything that changes either array's
 * MEMBERSHIP changes the pairing on the next edit even though it wrote no
 * pointer itself. Migration 0083's fold is exactly that: it moves slots between
 * role definitions, so it orders the arriving ones LAST precisely so the
 * positions this function derives are the ones it derived before.
 *
 * EXPORTED for that gate (`role-identity-fold.integration.test.ts`). It takes a
 * `DbOrTx`, so a test can drive the real re-derivation inside its own
 * transaction — which `applyAddSpeakerSlot` cannot do, since it opens a
 * transaction of its own on another pooled connection and could not see an
 * uncommitted fold.
 */
export async function realignEvaluatorPairs(
	tx: DbOrTx,
	meetingId: string,
	speakerRoleId: string,
	evaluatorRoleId: string | null,
) {
	// One def can satisfy BOTH picks — `isSpeakerRole: true` with
	// `category: "evaluator"` is a settable combination on any club role, and the
	// two heuristics in `pickSpeakerAndEvaluatorRoles` are independent. Treated as
	// a real pair it read one lineup as both sides and pointed every slot at
	// ITSELF, which every reader renders as "Speaker 2, evaluated by Speaker 2".
	// A role cannot evaluate itself, so there is no pair to maintain.
	const pairedEvaluatorRoleId =
		evaluatorRoleId === speakerRoleId ? null : evaluatorRoleId;
	const roleIds = pairedEvaluatorRoleId
		? [speakerRoleId, pairedEvaluatorRoleId]
		: [speakerRoleId];
	const rows = await tx
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
			evaluatesSlotId: roleSlots.evaluatesSlotId,
		})
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				inArray(roleSlots.roleDefinitionId, roleIds),
			),
		);
	// `id` breaks a tie on `slotIndex`. Duplicate indices are constructible — two
	// concurrent adds each compute the next index from a read taken before their
	// transaction, and no unique index stops them — and Postgres does not promise
	// a return order, so without the tiebreaker the same rows could renumber
	// differently on two runs. Pairing stays consistent with the numbering either
	// way (one `speakers` array drives both), but "which tied slot became 1" is
	// worth being reproducible.
	const ofRole = (roleId: string) =>
		rows
			.filter((r) => r.roleDefinitionId === roleId)
			.sort((a, b) => a.slotIndex - b.slotIndex || a.id.localeCompare(b.id));
	const speakers = ofRole(speakerRoleId);
	for (const [i, s] of speakers.entries()) {
		if (s.slotIndex !== i) {
			await tx
				.update(roleSlots)
				.set({ slotIndex: i })
				.where(eq(roleSlots.id, s.id));
		}
	}
	if (!pairedEvaluatorRoleId) return;
	for (const [i, e] of ofRole(pairedEvaluatorRoleId).entries()) {
		const target = speakers[i]?.id ?? null;
		if (e.slotIndex === i && e.evaluatesSlotId === target) continue;
		await tx
			.update(roleSlots)
			.set({ slotIndex: i, evaluatesSlotId: target })
			.where(eq(roleSlots.id, e.id));
	}
}

/** Shared body of the two reorder fns: swap `slotId` with its neighbor within
 *  its own role (up = lower index), then realign the positional pairing. */
async function applyMoveSlot(
	input: {
		slotId: string;
		direction: "up" | "down";
		actorMemberId: string | null;
	},
	kind: "speaker" | "evaluator",
) {
	const [target] = await db
		.select({
			id: roleSlots.id,
			meetingId: roleSlots.meetingId,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
			clubId: meetings.clubId,
			templateId: meetings.templateId,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(eq(roleSlots.id, input.slotId))
		.limit(1);
	if (!target) {
		throw new Error(
			kind === "speaker"
				? "Speaker slot not found."
				: "Evaluator slot not found.",
		);
	}

	const { speakerRoleId, evaluatorRoleId } = await clubRoles(
		target.clubId,
		target.templateId,
	);
	// The slot must actually BE of the kind this endpoint reorders. Both public
	// server fns take a bare `slotId`, so without this the caller's CHOICE of
	// endpoint decided the activity label while the swap ran on whatever role the
	// slot happened to hold — `moveEvaluatorSlot(<a speaker slot>)` reordered
	// speakers and wrote "reordered evaluators" into the feed.
	//
	// The two arms are deliberately ASYMMETRIC, because they mirror what the
	// agenda actually renders arrows on. Speaker arrows appear on every
	// `isSpeakerRole` card, and `isSpeakerRole` is a free checkbox on any
	// club-invented role — a second contestant lineup, a "Debater" — so narrowing
	// this arm to the one PICKED speaker role would have made the arrows on those
	// cards start erroring, a capability regression for a shape that worked
	// before. Evaluator arrows render only for the paired evaluator role (the
	// General Evaluator gets none), so that arm stays exact.
	const kindOk =
		kind === "speaker"
			? target.isSpeakerRole
			: evaluatorRoleId !== null && target.roleDefinitionId === evaluatorRoleId;
	if (!kindOk) {
		throw new Error(
			kind === "speaker"
				? "That slot is not a speaker slot."
				: "That slot is not an evaluator slot.",
		);
	}
	// Only the PICKED pair carries positional links, so reordering some other
	// speaker-flagged lineup must not re-point them.
	const movedThePairedLineup =
		target.roleDefinitionId === speakerRoleId ||
		target.roleDefinitionId === evaluatorRoleId;

	await db.transaction(async (tx) => {
		await lockMeetingForSlotEdit(tx, target.meetingId);
		// The lineup is read INSIDE the lock: "which slot sits next to this one"
		// is the decision this function exists to make, and a concurrent add or
		// reorder changes the answer. Read outside, two officers acting at once
		// could each swap against a stale neighbour and commit an order neither
		// of them saw.
		const siblings = await tx
			.select({ id: roleSlots.id, slotIndex: roleSlots.slotIndex })
			.from(roleSlots)
			.where(
				and(
					eq(roleSlots.meetingId, target.meetingId),
					eq(roleSlots.roleDefinitionId, target.roleDefinitionId),
				),
			);
		const ordered = siblings.sort(
			(a, b) => a.slotIndex - b.slotIndex || a.id.localeCompare(b.id),
		);
		const pos = ordered.findIndex((s) => s.id === target.id);
		// Kind-specific, like the not-found throw above: the slot was deleted while
		// this call waited for the meeting lock.
		if (pos === -1) {
			throw new Error(
				kind === "speaker"
					? "Speaker slot not found."
					: "Evaluator slot not found.",
			);
		}
		const self = ordered[pos];
		const neighbor =
			input.direction === "up" ? ordered[pos - 1] : ordered[pos + 1];
		if (!neighbor) throw new Error("No slot to swap with.");
		await tx
			.update(roleSlots)
			.set({ slotIndex: neighbor.slotIndex })
			.where(eq(roleSlots.id, self.id));
		await tx
			.update(roleSlots)
			.set({ slotIndex: self.slotIndex })
			.where(eq(roleSlots.id, neighbor.id));
		if (movedThePairedLineup) {
			await realignEvaluatorPairs(
				tx,
				target.meetingId,
				speakerRoleId,
				evaluatorRoleId,
			);
		}
		await logActivity(tx, {
			clubId: target.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: target.meetingId,
			detail: {
				change:
					kind === "speaker" ? "speaker_reordered" : "evaluator_reordered",
			},
		});
	});
	return { clubId: target.clubId };
}

/** Swap a speaker slot's position with its neighbor (up = lower index), then
 *  re-point the evaluator links positionally — the evaluator LINEUP stays put,
 *  so Evaluator 1 always evaluates whoever now speaks first. */
export async function applyMoveSpeakerSlot(input: {
	slotId: string;
	direction: "up" | "down";
	actorMemberId: string | null;
}) {
	return applyMoveSlot(input, "speaker");
}

/** Swap an evaluator slot's position with its neighbor (up = lower index),
 *  then re-point the links positionally (Evaluator N ↔ Speaker N). */
export async function applyMoveEvaluatorSlot(input: {
	slotId: string;
	direction: "up" | "down";
	actorMemberId: string | null;
}) {
	return applyMoveSlot(input, "evaluator");
}

// ---------------------------------------------------------------------------
// Speeches — first-class, Person-owned content (ADR-0009 / #79). A speaker slot
// references a speech via `role_slots.speech_id`; these helpers create/edit/
// unlink that pointer without ever destroying the speech itself.
// ---------------------------------------------------------------------------

// Field names mirror the legacy speaker-details form input, so existing callers
// pass the same shape; `speechTitle` maps to `speeches.title`.
export type SpeechInput = {
	speechTitle?: string;
	introduction?: string;
	pathwayPath?: string;
	projectName?: string;
	projectLevel?: string;
	/** A real catalog project (#418). Null clears the link back to free text. */
	projectId?: string | null;
	minMinutes?: number;
	maxMinutes?: number;
	presentationUrl?: string;
};

export type SpeechContent = {
	title: string;
	introduction: string | null;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	projectId: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	presentationUrl: string | null;
};

/**
 * Normalize raw speech form input to persistable content plus a `hasContent`
 * flag. `hasContent` is false for a pure-TBA / empty input (blank or "TBA" title
 * and no other field set) — the caller then leaves the slot's `speech_id` NULL
 * instead of creating a blank speech (mirrors the migration's empty-placeholder
 * rule and keeps "TBA" a derived, unstored state).
 *
 * Stays PURE. A picked `projectId` also has to overwrite the free-text triple
 * from the catalog, but that needs a query, so it happens in the callers via
 * `applyProjectDisplay` rather than turning this into an async function every
 * existing test would have to await.
 */
export function normalizeSpeech(input?: SpeechInput): {
	content: SpeechContent;
	hasContent: boolean;
} {
	const title = input?.speechTitle?.trim() ?? "";
	const introduction = input?.introduction?.trim() || null;
	const pathwayPath = input?.pathwayPath?.trim() || null;
	const projectName = input?.projectName?.trim() || null;
	const projectLevel = input?.projectLevel?.trim() || null;
	const projectId = input?.projectId?.trim() || null;
	const minMinutes = input?.minMinutes ?? null;
	const maxMinutes = input?.maxMinutes ?? null;
	const presentationUrl = normalizePresentationUrl(input?.presentationUrl);
	const hasOtherContent =
		introduction !== null ||
		pathwayPath !== null ||
		projectName !== null ||
		projectLevel !== null ||
		projectId !== null ||
		minMinutes !== null ||
		maxMinutes !== null ||
		presentationUrl !== null;
	const hasRealTitle = isRealSpeechTitle(title);
	return {
		content: {
			title: title.length > 0 ? title : TBA_SPEECH_TITLE,
			introduction,
			pathwayPath,
			projectName,
			projectLevel,
			projectId,
			minMinutes,
			maxMinutes,
			presentationUrl,
		},
		hasContent: hasRealTitle || hasOtherContent,
	};
}

/**
 * Overwrite the free-text triple from the catalog when a real project was
 * picked (#418).
 *
 * The whole display layer — agenda, print layouts, the projected deck, the run
 * sheet, reporting — reads `pathway_path` / `project_name` / `project_level`,
 * which the schema documents as the fallback display "until project_id coverage
 * is high". Deriving them server-side means every one of those surfaces keeps
 * working with no change, and the fallback text can never drift from the linked
 * project. A speech with no picked project is left exactly as typed.
 */
async function applyProjectDisplay(
	content: SpeechContent,
): Promise<SpeechContent> {
	if (!content.projectId) return content;
	const display = await resolveProjectDisplay(content.projectId);
	return { ...content, ...display };
}

/**
 * Attach a new Person-owned Speech to a freshly-claimed speaker slot and point
 * the slot at it. Pure-TBA / empty input creates nothing (slot stays TBA,
 * `speech_id` NULL). Returns the new speech id, or null when nothing was created.
 * Assumes the slot has no speech yet (a just-claimed slot).
 */
export async function attachSpeechToSlot(
	conn: DbOrTx,
	args: { slotId: string; personId: string; input?: SpeechInput },
): Promise<string | null> {
	const { content, hasContent } = normalizeSpeech(args.input);
	if (!hasContent) return null;
	const values = await applyProjectDisplay(content);
	const [row] = await conn
		.insert(speeches)
		.values({ personId: args.personId, ...values })
		.returning({ id: speeches.id });
	if (!row) throw new Error("Failed to create speech.");
	await conn
		.update(roleSlots)
		.set({ speechId: row.id })
		.where(eq(roleSlots.id, args.slotId));
	return row.id;
}

/**
 * Unlink a slot's speech (set `speech_id` NULL). The speech row is NOT deleted —
 * it persists Person-owned and unscheduled (ADR-0009 pointer lifecycle). Safe to
 * call when the slot has no speech.
 */
export async function unlinkSlotSpeech(
	conn: DbOrTx,
	slotId: string,
): Promise<void> {
	await conn
		.update(roleSlots)
		.set({ speechId: null })
		.where(eq(roleSlots.id, slotId));
}

/**
 * Apply the reassign pointer rule (ADR-0009): when a speaker slot moves to a
 * *different* Person, unlink the speech (it persists Person-owned and
 * unscheduled); moving within the same Person keeps the speech attached. Returns
 * whether the speech was unlinked. Call after repointing the slot's assignee.
 */
export async function reassignSlotSpeech(
	conn: DbOrTx,
	args: {
		slotId: string;
		fromPersonId: string | null;
		toPersonId: string | null;
	},
): Promise<boolean> {
	if (args.fromPersonId === args.toPersonId) return false;
	await unlinkSlotSpeech(conn, args.slotId);
	return true;
}

/**
 * Self-claiming a role is the strongest "I'm coming" statement, so it records
 * the claimant as `coming` for that meeting — spec 2026-07-13. Admin
 * assignments (actor ≠ member, or no actor) must NOT speak for the member, so
 * they no-op; the early return is the whole self-only rule.
 *
 * This used to DELETE the claimant's row in the old, now-dropped availability
 * table, which threw the information away — "no answer" and "coming" were the
 * same absent row. The three-rung ladder can hold the answer, so it does, and
 * PR 2's planned-attendance panel renders it (D6, 2026-08-11).
 *
 * Writes only when the answer actually CHANGES, which is what #211 was really
 * about: claiming is the most common write in this product, and a member taking
 * three roles in one meeting must not put three identical "said they're coming"
 * rows in the feed. `demoteFrom` carries that rule INTO the upsert rather than
 * reading first: a preceding SELECT lost the race it existed to win, since two
 * concurrent claims in separate transactions both read "not coming yet" under
 * READ COMMITTED and both logged. One statement, so the row lock decides.
 *
 * The rule stays here rather than in `setPlanStatus` — re-affirming "coming"
 * through an explicit writer is a real user action worth logging; it is only the
 * IMPLICIT answer inside a claim that is noise.
 */
export async function markComingOnSelfClaim(
	tx: DbOrTx,
	args: {
		memberId: string;
		actorMemberId: string | null;
		meetingId: string;
		clubId: string;
	},
): Promise<void> {
	if (args.actorMemberId === null || args.memberId !== args.actorMemberId)
		return;
	await setPlanStatus(tx, {
		memberId: args.memberId,
		meetingId: args.meetingId,
		clubId: args.clubId,
		status: "coming",
		actorMemberId: args.memberId,
		// Every rung EXCEPT `coming` — so an existing `coming` row is left alone
		// and logs nothing, while a decline or an officer's ask is correctly
		// superseded by the strongest statement the member can make.
		demoteFrom: ["reached_out", "not_coming"],
	});
}

/**
 * WHICH arm admitted a confirm (#661). Persisted as
 * `activity_log.detail.grantedVia`, for the reason CLAUDE.md's actor-provenance
 * rule gives about the TMOD ladder: an officer's vouch and the member's own
 * answer are otherwise indistinguishable in the feed, and "confirmed" is the one
 * word whose meaning differs entirely between them.
 */
export type ConfirmSlotVia = "officer" | "self";

/** The public arm's rejection. Exported so a test matches the string the code
 *  raises rather than a copy of it that can drift. */
export const NOT_THE_SLOT_HOLDER_MESSAGE =
	"Only the member who holds this role can confirm it.";

/** Raised when the officer arm is taken with no session at all.
 *
 *  An ALIAS, not a copy (#761). This string and `requireUser`'s were already
 *  identical by hand; the client now matches it through
 *  `isSignInRequiredError` to decide whether a refusal toast offers a "Sign in"
 *  action, so a divergence here would silently downgrade that toast to a plain
 *  one with nothing failing. Kept exported under this name because
 *  `slots-confirm.integration.test.ts` and its callers read it. */
export const CONFIRM_NEEDS_SIGN_IN_MESSAGE = SIGN_IN_REQUIRED_MESSAGE;

/**
 * Confirm a claimed slot, from either of two arms (#661).
 *
 * Until #661 "confirmed" meant *an officer vouched for this person*, because
 * `confirmSlot` was `requireUser()` + `requireClubRole(admin)` and there was no
 * member-facing confirm anywhere in the product. The holder arm is what makes it
 * able to mean *the person said yes* — and only then is it honest for the
 * attendance rail to draft "just confirming you're our Toastmaster".
 *
 * Which arm runs is decided by ONE thing: whether the caller asserted a
 * `selfMemberId`. Not by whether a session happens to exist, and not by trying
 * the officer arm first and falling back — an assertion that does not hold is a
 * failed assertion, and silently re-admitting that caller as an officer would
 * both mask a mistyped member id and record the wrong `grantedVia` for it.
 *
 *  - **self** — `selfMemberId` must equal `role_slots.assigned_member_id`. Same
 *    honour-system trust level as `claimSlot` and `setAvailability`, which
 *    already take a raw member id with no session; it grants strictly less,
 *    since the id has to match a slot the server read itself. The actor credited
 *    is the assignee VERIFIED against that row, which is the
 *    `resolveMeetingAgendaAuthz` TMOD precedent ("verified against the slot
 *    above, so it is safe to credit") rather than `requestWriteActor`'s
 *    membership precedence — crediting the resolved caller instead would file
 *    "Alice says Bob is coming" under a `grantedVia: "self"` row and contradict
 *    it. A signed-in member of this club can therefore still assert the holder's
 *    id; so can anyone at all, from a logged-out browser, which is what the
 *    honour system means here and why closing it for the signed-in half only
 *    would buy nothing.
 *  - **officer** — unchanged from before #661, including its messages: a session
 *    plus `requireClubRole(admin)`. Writes NO plan row, deliberately: nobody
 *    answered, so `buildPlanPanel` should keep inferring `Coming · assumed` from
 *    the confirmed slot rather than claiming an answer exists.
 *
 * Lives here rather than in the `slots.ts` handler for the reason
 * CODING_STANDARDS.md gives for the other session-less writes: a handler body is
 * unreachable from vitest, so a gate that lives in one is covered by a source
 * grep and nothing else. Everything below — including the archive gate — is
 * executed by `slots-confirm.integration.test.ts`.
 */
export async function confirmSlotCore(args: {
	slotId: string;
	/** The signed-in user's id, or null. Only the officer arm reads it. */
	sessionUserId: string | null;
	/** Self-asserted holder id (the public arm), or null for the officer arm. */
	selfMemberId: string | null;
}): Promise<{ ok: true; grantedVia: ConfirmSlotVia; planWritten: boolean }> {
	const [slot] = await db
		.select({
			id: roleSlots.id,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			meetingId: roleSlots.meetingId,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, args.slotId))
		.limit(1);

	if (!slot) {
		throw new Error("Role not found.");
	}

	// #555/#661. The holder arm takes NO session, so it reaches none of the
	// enforcement points `requireClubRole` carries for the officer arm — this
	// call is the only thing standing between an anonymous caller and a write to
	// a taken-down club. Before BOTH the lock check and either grant arm: a
	// taken-down club must refuse for the reason it was taken down rather than
	// leaking that the meeting is completed, and gating after the officer arm
	// returned would leave the wider (session-less) half open anyway. Same
	// ordering, for the same two reasons, as `resolveMeetingAgendaAuthz`.
	await assertClubNotArchived(slot.clubId);
	assertMeetingNotLocked(slot.meetingStatus);

	const grant = await resolveConfirmGrant(args, slot);

	if (slot.status !== "claimed") {
		throw new Error("Only a claimed role can be confirmed.");
	}

	return db.transaction(async (tx) => {
		// Conditional UPDATE: only flips 'claimed' → 'confirmed'; a concurrent
		// release that races us back to 'open' will produce zero rows.
		//
		// The self arm ALSO re-asserts the holder here, and that is not belt-and-
		// braces. The slot read above happens OUTSIDE this transaction and takes no
		// `FOR UPDATE`, so `resolveConfirmGrant` decides on a snapshot. Status alone
		// does not close the window, because a reassignment is not a release:
		// `reassignSlotCore` sets `assignedMemberId` to the NEW holder and leaves
		// `status` at 'claimed', so a plain id+status match still fires. Without
		// this clause, Alice confirming while the VPE reassigns to Bob flips BOB's
		// slot to 'confirmed' — a role he never accepted, rendering as
		// `Coming · assumed` — and writes the `coming` plan row for ALICE, who by
		// then holds nothing. Matching on the holder makes the check-then-act
		// atomic: the row the grant was resolved against is the row we update, or
		// we update nothing.
		const updated = await tx
			.update(roleSlots)
			.set({ status: "confirmed" })
			.where(
				and(
					eq(roleSlots.id, args.slotId),
					eq(roleSlots.status, "claimed"),
					grant.via === "self"
						? eq(roleSlots.assignedMemberId, grant.holderMemberId)
						: undefined,
				),
			)
			.returning({ id: roleSlots.id });

		if (updated.length === 0) {
			throw new Error(
				"Slot was no longer claimed — it may have been released or reassigned concurrently.",
			);
		}

		let planWritten = false;
		if (grant.via === "self") {
			// In the SAME transaction as the flip, so a confirm can never half-land
			// as "the slot says yes but the rail says no answer".
			const { changed } = await setPlanStatus(tx, {
				memberId: grant.holderMemberId,
				meetingId: slot.meetingId,
				clubId: slot.clubId,
				status: "coming",
				actorMemberId: grant.actorMemberId,
				grantedVia: "self",
				// `markComingOnSelfClaim`'s list, and for its reason: every rung
				// EXCEPT `coming`, so a re-confirm logs nothing while a decline or an
				// officer's ask is superseded. Confirming the role after previously
				// declining is a real change of mind and should win — and it is the
				// member's OWN answer either way, so this floor never lets one person
				// overwrite another's: `reached_out` is the officer's ask, not a
				// reply, and `not_coming` here can only be this member's.
				demoteFrom: ["reached_out", "not_coming"],
			});
			planWritten = changed;
		}

		await logActivity(tx, {
			clubId: slot.clubId,
			actorMemberId: grant.actorMemberId,
			action: "claim",
			targetType: "slot",
			targetId: args.slotId,
			detail: { confirmed: true, grantedVia: grant.via },
		});

		return { ok: true as const, grantedVia: grant.via, planWritten };
	});
}

/** The resolved arm. A union rather than two loose fields so the plan write can
 *  only reach a holder id the self arm actually verified. */
type ConfirmGrant =
	| { via: "self"; actorMemberId: string; holderMemberId: string }
	| { via: "officer"; actorMemberId: string | null };

async function resolveConfirmGrant(
	args: { sessionUserId: string | null; selfMemberId: string | null },
	slot: { assignedMemberId: string | null; clubId: string },
): Promise<ConfirmGrant> {
	if (args.selfMemberId !== null) {
		if (
			slot.assignedMemberId === null ||
			slot.assignedMemberId !== args.selfMemberId
		) {
			throw new Error(NOT_THE_SLOT_HOLDER_MESSAGE);
		}
		return {
			via: "self",
			actorMemberId: slot.assignedMemberId,
			holderMemberId: slot.assignedMemberId,
		};
	}
	if (!args.sessionUserId) {
		throw new Error(CONFIRM_NEEDS_SIGN_IN_MESSAGE);
	}
	// The actor is the resolved admin membership — never the client (#396).
	const membership = await requireClubRole(args.sessionUserId, slot.clubId, [
		"admin",
	]);
	return { via: "officer", actorMemberId: membership.id };
}

/**
 * Reassign a slot to a different member, atomically (ADR-0005). MUST run inside
 * a caller-provided transaction: it re-reads the slot **with a FOR UPDATE row
 * lock** so the read that decides the speech keep-or-unlink and the write happen
 * as one serialized unit — a concurrent release/claim/reassign can no longer be
 * silently overwritten from a stale prior-assignee read.
 *
 * Deliberately allows assigning an *open* slot (admin/VPE assign-to-member
 * flows) — the guarantee here is atomicity, not a status precondition. Returns
 * the slot's club id so the caller can trust-guard/log against it, and
 * `wasOpen` so a caller can describe what it did without re-reading.
 *
 * **`wasOpen` is read under the row lock, and so is the activity action it
 * decides** (#809). Whether the slot was open is only true-or-false under the
 * lock this function takes; a caller reading it beforehand would be doing a
 * check-then-act on exactly the field the lock exists to serialize. So the log
 * is written here rather than by the caller, and it names what actually
 * happened: assigning an OPEN slot is a `claim`, taking it off someone else is
 * a `reassign`. Before #809 it was always `reassign`, which
 * `activity-format.ts` renders as "reassigned Timer: someone → Sam" — a
 * sentence with a `from` nobody can supply, because there was no prior holder.
 * The browser path reaches this with an open slot only when the slot was
 * released between the page load and the click, so this changes the feed for a
 * race and for `assign_roles`, and for nothing else.
 *
 * It does NOT fix the same sentence for a GUEST-held slot, and that limit is
 * worth stating because the obvious reading of the paragraph above is that it
 * does. A guest-held slot is `claimed` with a null `assigned_member_id`, so
 * taking it for a member still logs `reassign` with `fromMemberId: null` and
 * still renders "someone → Sam". Carrying a `fromGuestId` here would not be
 * enough on its own: `activity-feed-logic.ts:218` resolves `fromName` from
 * `fromMemberId` alone, so that case needs the feed changed too.
 *
 * #809 specified returning `wasOpen` so a caller could pick the action without
 * re-reading. Deciding it HERE, under the lock, is the same fix by a shorter
 * route, and returning the flag as well would be surface nothing reads.
 */
export async function reassignSlotCore(
	tx: DbOrTx,
	args: { slotId: string; memberId: string; actorMemberId: string | null },
): Promise<{ clubId: string }> {
	// Lock only the role_slots row; FOR UPDATE on the joined role_definitions /
	// meetings catalog rows is unnecessary (they don't change under us).
	const [slot] = await tx
		.select({
			id: roleSlots.id,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
			meetingId: roleSlots.meetingId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, args.slotId))
		.limit(1)
		.for("update", { of: roleSlots });
	if (!slot) throw new Error("Role not found.");
	// Lock choke point (#150): reassign/claim-to-member on a completed meeting is
	// rejected here under the row lock.
	assertMeetingNotLocked(slot.meetingStatus);

	// Reassigning a speaker slot to a *different* Person unlinks the speech; the
	// old speech persists Person-owned and unscheduled (ADR-0009). Within the
	// same Person it keeps the speech. Both persons are read under the lock.
	const personOf = async (memberId: string | null) =>
		memberId
			? ((
					await tx
						.select({ personId: members.personId })
						.from(members)
						.where(eq(members.id, memberId))
						.limit(1)
				)[0]?.personId ?? null)
			: null;
	const fromPerson = slot.isSpeakerRole
		? await personOf(slot.assignedMemberId)
		: null;
	const toPerson = slot.isSpeakerRole ? await personOf(args.memberId) : null;

	// New holder hasn't been confirmed → back to "claimed".
	await tx
		.update(roleSlots)
		.set({
			assignedMemberId: args.memberId,
			assignedGuestId: null,
			status: "claimed",
		})
		.where(eq(roleSlots.id, args.slotId));

	await markComingOnSelfClaim(tx, {
		memberId: args.memberId,
		actorMemberId: args.actorMemberId,
		meetingId: slot.meetingId,
		clubId: slot.clubId,
	});

	// Unlink the speech only when the Person actually changed.
	if (slot.isSpeakerRole) {
		await reassignSlotSpeech(tx, {
			slotId: args.slotId,
			fromPersonId: fromPerson,
			toPersonId: toPerson,
		});
	}

	const wasOpen = slot.status === "open";
	await logActivity(tx, {
		clubId: slot.clubId,
		actorMemberId: args.actorMemberId,
		action: wasOpen ? "claim" : "reassign",
		targetType: "slot",
		targetId: args.slotId,
		// `claim` carries no `fromMemberId` — `claimSlot`'s own log does not
		// either, and on an open slot there is nothing for it to name.
		detail: wasOpen
			? { memberId: args.memberId }
			: {
					fromMemberId: slot.assignedMemberId,
					memberId: args.memberId,
				},
	});

	return { clubId: slot.clubId };
}

/**
 * Clear a slot back to `open`, atomically (#809).
 *
 * Extracted from `releaseSlot`'s handler body, which is where this logic lived
 * from the start. Three things about the extraction are load-bearing.
 *
 * **It takes the caller's connection and the row lock.** `assign_roles` clears
 * slots inside a batch that must apply entirely or not at all, so this cannot
 * open a transaction of its own — and it re-reads the slot `FOR UPDATE` the way
 * `reassignSlotCore` does, because the handler's shape (read the row on `db`,
 * remember `assigned_member_id` for the log, then write in a transaction) is a
 * check-then-act the moment it sits inside a batch that is otherwise
 * lock-serialized. The archive gate reads through `conn` for the same reason a
 * second connection is the thing to avoid here at all: the batch is already
 * holding locks.
 *
 * **`actorMemberId` is an ARGUMENT, not something this resolves.** Release is
 * the honour-system clear any club member may perform from a shared link with
 * no session at all, and the handler resolves the actor through
 * `requestWriteActor` — a REQUEST-scoped read that the MCP path has no way to
 * supply. Pulling that resolution in here would make the seam unreachable from
 * the tool; `reassignSlotCore` takes its actor the same way and for the same
 * reason.
 *
 * **The archive gate moved here with the logic**, and that is the whole reason
 * the move is worth making: a handler body is unreachable from vitest, so while
 * the gate lived in `slots.ts` the only thing covering a session-less write to
 * a taken-down club was a source grep. `public-writers-archive-gate.integration.test.ts`
 * now executes it. `public-readers-archive-gate.guard.test.ts`'s `WRITE_GATES`
 * row is re-pointed at this file — but that row is a file-level `toContain`,
 * and this module calls `assertClubNotArchived` from a SECOND function
 * (`confirmSlotCore`) besides naming it on the import line, so the guard stays
 * green with the call below deleted. MEASURED: deleting it left every case in
 * that guard passing and turned the two behavioural cases red. The guard only
 * says the module still has a gate somewhere.
 *
 * Release unlinks the slot's speech (`speech_id` → NULL) and never deletes it:
 * the speech persists Person-owned and unscheduled (ADR-0009).
 */
export async function releaseSlotCore(
	conn: DbOrTx,
	args: { slotId: string; actorMemberId: string | null },
): Promise<{ clubId: string }> {
	// Lock only the role_slots row; the joined meetings row does not change
	// under us. Same shape as `reassignSlotCore`, so a clear and a reassign of
	// the same slot serialize against each other.
	const [slot] = await conn
		.select({
			id: roleSlots.id,
			// The only column the body reads: the activity row names the prior
			// member holder, exactly as the handler's did before the extraction.
			assignedMemberId: roleSlots.assignedMemberId,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, args.slotId))
		.limit(1)
		.for("update", { of: roleSlots });
	if (!slot) throw new Error("Role not found.");

	// #555. PUBLIC — no session, so `requireMembership` never runs and the
	// archive check never arrives for free. Before the lock check, because a
	// taken-down club should refuse for the reason it was taken down rather than
	// for the meeting's status.
	await assertClubNotArchived(slot.clubId, conn);
	assertMeetingNotLocked(slot.meetingStatus);

	await conn
		.update(roleSlots)
		.set({
			assignedMemberId: null,
			assignedGuestId: null,
			status: "open",
			claimedAt: null,
			speechId: null,
		})
		.where(eq(roleSlots.id, slot.id));

	await logActivity(conn, {
		clubId: slot.clubId,
		actorMemberId: args.actorMemberId,
		action: "release",
		targetType: "slot",
		targetId: args.slotId,
		detail: { fromMemberId: slot.assignedMemberId },
	});

	// `clubId` alone, matching `reassignSlotCore`. The prior holder and the
	// unlinked speech were returned too until review: nothing read them, and an
	// unread field is a claim about a caller that does not exist.
	return { clubId: slot.clubId };
}

/**
 * Edit the speech attached to a speaker slot (the "Edit speech" flow):
 *  - real content + slot already has a speech → update that speech in place.
 *  - real content + no speech yet → create one owned by `personId` and link it.
 *  - blank/TBA input + slot has a speech → unlink it (the speech persists).
 *  - blank/TBA input + no speech → no-op.
 * `personId` is the current assignee's Person (required to own a new speech).
 */
export async function editSlotSpeech(
	conn: DbOrTx,
	args: {
		slotId: string;
		personId: string;
		currentSpeechId: string | null;
		input?: SpeechInput;
	},
): Promise<void> {
	const { content, hasContent } = normalizeSpeech(args.input);
	if (!hasContent) {
		if (args.currentSpeechId) await unlinkSlotSpeech(conn, args.slotId);
		return;
	}
	if (args.currentSpeechId) {
		const values = await applyProjectDisplay(content);
		await conn
			.update(speeches)
			.set({ ...values, updatedAt: new Date() })
			.where(eq(speeches.id, args.currentSpeechId));
		return;
	}
	await attachSpeechToSlot(conn, {
		slotId: args.slotId,
		personId: args.personId,
		input: args.input,
	});
}

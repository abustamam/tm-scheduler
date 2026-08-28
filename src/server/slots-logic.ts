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
import { logActivity } from "./activity";
import { setPlanStatus } from "./attendance-plan-logic";
import { assertMeetingNotLocked } from "./meeting-authz-logic";
import { roleDefScope } from "./meeting-templates-logic";
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
	const defs = await db
		.select({
			id: roleDefinitions.id,
			category: roleDefinitions.category,
			defaultCount: roleDefinitions.defaultCount,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			enabled: roleDefinitions.enabled,
		})
		.from(roleDefinitions)
		// Scoped to the MEETING's shape. Unscoped, a contest meeting's
		// "+ Add speaker" resolves through `pickSpeakerAndEvaluatorRoles`, which
		// takes the lowest `sortOrder` speaker role across the union — the club's
		// standard Speaker — and adds a slot that renders nowhere on the contest
		// sheet, leaving no in-product way to change the contestant count.
		.where(roleDefScope(clubId, templateId));
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
		// Read under the lock: computed OUTSIDE the transaction, two concurrent
		// adds both resolved the same "next" index and both inserted it.
		const existing = await tx
			.select({
				roleDefinitionId: roleSlots.roleDefinitionId,
				slotIndex: roleSlots.slotIndex,
			})
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, input.meetingId));
		const idxFor = (roleId: string) =>
			nextIndex(
				existing
					.filter((s) => s.roleDefinitionId === roleId)
					.map((s) => s.slotIndex),
			);
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
				slotIndex: idxFor(speakerRoleId),
			})
			.returning({ id: roleSlots.id });
		if (evaluatorRoleId && evaluatorEnabled) {
			await tx.insert(roleSlots).values({
				meetingId: input.meetingId,
				roleDefinitionId: evaluatorRoleId,
				slotIndex: idxFor(evaluatorRoleId),
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

/** The club's role defs in the shape `pairedRoleIds` needs, plus name/id/enabled. */
async function clubRoleDefs(clubId: string, templateId: string | null) {
	return db
		.select({
			id: roleDefinitions.id,
			name: roleDefinitions.name,
			category: roleDefinitions.category,
			defaultCount: roleDefinitions.defaultCount,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			enabled: roleDefinitions.enabled,
		})
		.from(roleDefinitions)
		.where(roleDefScope(clubId, templateId));
}

/** Add one open slot of an arbitrary non-paired role to a meeting. Duplicates
 *  allowed (next slotIndex). Rejects the speaker/paired-evaluator roles (those
 *  go through the +/- speaker buttons) and roles from another club. */
export async function applyAddRoleSlot(input: {
	meetingId: string;
	roleDefinitionId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	assertMeetingNotLocked(meeting.status);

	const defs = await clubRoleDefs(meeting.clubId, meeting.templateId);
	const role = defs.find((d) => d.id === input.roleDefinitionId);
	if (!role) throw new Error("Role not found for this club.");
	if (!role.enabled) throw new Error("This role is currently disabled.");
	if (pairedRoleIds(defs).has(role.id)) {
		throw new Error("Add speakers with the speaker controls.");
	}

	const existing = await db
		.select({ slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, input.meetingId),
				eq(roleSlots.roleDefinitionId, input.roleDefinitionId),
			),
		);
	const slotIndex = nextIndex(existing.map((s) => s.slotIndex));

	await db.transaction(async (tx) => {
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
	});
	return { clubId: meeting.clubId };
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

	const defs = await clubRoleDefs(slot.clubId, slot.templateId);
	if (pairedRoleIds(defs).has(slot.roleDefinitionId)) {
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
 *  how many meetings changed and the distinct role names added. */
async function backfillMissingRoleSlots(input: {
	clubId: string;
	meetingIds: string[];
	defs: { id: string; name: string }[];
	actorMemberId: string | null;
	changeLabel: BackfillChangeLabel;
}): Promise<{ meetingsChanged: number; rolesAdded: string[] }> {
	const rolesAdded = new Set<string>();
	let meetingsChanged = 0;

	await db.transaction(async (tx) => {
		for (const meetingId of input.meetingIds) {
			const present = await tx
				.select({ roleDefinitionId: roleSlots.roleDefinitionId })
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, meetingId));
			const presentIds = new Set(present.map((s) => s.roleDefinitionId));
			const missing = input.defs.filter((d) => !presentIds.has(d.id));
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
	const defs = await clubRoleDefs(input.clubId, null);
	const paired = pairedRoleIds(defs);
	// `enabled` matters here (#368): without it, disabling a role (e.g.
	// Ah-Counter) and then clicking this button would re-add it to every
	// upcoming meeting — exactly the workflow the toggle exists to prevent.
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

	const defs = await clubRoleDefs(input.clubId, null);
	const isPaired = pairedRoleIds(defs).has(input.roleDefinitionId);
	if (isPaired || input.defaultCount < 1) {
		return { keptClaimedMeetings: 0, meetingsChanged: 0, rolesAdded: [] };
	}

	const result = await backfillMissingRoleSlots({
		clubId: input.clubId,
		meetingIds,
		defs: [{ id: input.roleDefinitionId, name: input.roleName }],
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
 * Does NOT serialize against `claimSlot`, which locks the slot row instead — see
 * TODOS.md for the remove-vs-claim window that leaves open.
 */
async function lockMeetingForSlotEdit(
	tx: DbOrTx,
	meetingId: string,
): Promise<void> {
	const [locked] = await tx
		.select({ id: meetings.id })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.for("update")
		.limit(1);
	if (!locked) throw new Error("Meeting not found.");
}

/**
 * Positional pairing (Evaluator N ↔ Speaker N): renumber both paired roles'
 * slots densely (0..n-1, by current order) and point evaluator i at speaker i
 * (surplus evaluators at nothing). Runs inside every mutation that changes
 * either role's order or membership — add, remove, and both moves — so the
 * stored `evaluates_slot_id` never disagrees with the numbers on the cards.
 * A meeting left crossed by the old sticky-follows-the-person pairing heals on
 * its next edit; untouched meetings (past ones included) keep their history.
 */
async function realignEvaluatorPairs(
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
	const hasRealTitle = title.length > 0 && title !== "TBA";
	return {
		content: {
			title: title.length > 0 ? title : "TBA",
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
 * Reassign a slot to a different member, atomically (ADR-0005). MUST run inside
 * a caller-provided transaction: it re-reads the slot **with a FOR UPDATE row
 * lock** so the read that decides the speech keep-or-unlink and the write happen
 * as one serialized unit — a concurrent release/claim/reassign can no longer be
 * silently overwritten from a stale prior-assignee read.
 *
 * Deliberately allows assigning an *open* slot (admin/VPE assign-to-member
 * flows) — the guarantee here is atomicity, not a status precondition. Returns
 * the slot's club id so the caller can trust-guard/log against it.
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

	await logActivity(tx, {
		clubId: slot.clubId,
		actorMemberId: args.actorMemberId,
		action: "reassign",
		targetType: "slot",
		targetId: args.slotId,
		detail: {
			fromMemberId: slot.assignedMemberId,
			memberId: args.memberId,
		},
	});

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

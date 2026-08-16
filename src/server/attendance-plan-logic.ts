import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "#/db";
import {
	type attendancePlanStatusEnum,
	meetingAttendancePlan,
	members,
} from "#/db/schema";
import { logActivity } from "./activity";

// Either the main db client or a drizzle transaction — so callers writing
// inside their own transaction (e.g. `releaseSlotsAndMarkUnavailable`) can
// pass `tx` and commit atomically with the rest of their change.
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

// DERIVED from the Postgres enum, never hand-listed — see the same warning in
// `./activity.ts`. #510 hit exactly this from the other side: a hand-listed
// union that duplicated `activity_action` drifted from the database, and only
// `tsc` caught it once `vote_open`/`vote_close` were added to the enum.
export type AttendancePlanStatus =
	(typeof attendancePlanStatusEnum.enumValues)[number];

/**
 * The rungs a member may set for THEMSELVES. `reached_out` is missing on
 * purpose: it is an officer's record of having asked, not an answer, so the
 * self-serve surfaces neither write it nor may erase it. Pass this as
 * `onlyFrom` / `demoteFrom` from any session-less caller.
 */
export const SELF_SERVICE_RUNGS: readonly AttendancePlanStatus[] = [
	"coming",
	"not_coming",
];

/**
 * THE only module that reads or writes `meeting_attendance_plan`, apart from the
 * membership merge (`membership-collapse-logic.ts`), which re-points `member_id`
 * in raw SQL and is waived by name in `attendance-plan-store.guard.test.ts`.
 *
 * Row absent = "no answer"; there is no fourth enum value for it, because a row
 * that means "nothing is known" is a row every reader has to remember to ignore.
 *
 * `not_coming` is the sole encoding of "unavailable" in the database. Anything
 * asking "is this member out?" MUST come through here rather than testing for
 * row presence — the whole point of the consolidation is that presence no
 * longer answers that question.
 *
 * WHAT THIS SEAM OWNS, precisely: actor attribution, and the two status
 * predicates below. It does NOT own the archive gate or the officer-only
 * `reached_out` rung — those live in the callers (`attendance-plan.ts` and the
 * legacy delegates), because they need a session to evaluate. An earlier draft
 * of this comment claimed otherwise, which is exactly how a caller ends up
 * assuming it inherited a check it never got.
 */
export async function setPlanStatus(
	database: DbOrTx,
	args: {
		memberId: string;
		meetingId: string;
		clubId: string;
		status: AttendancePlanStatus;
		/** Null is a decision, not an omission: an impersonated write resolves to
		 *  null and `logActivity` stamps the real superadmin for it. */
		actorMemberId: string | null;
		/** How the change happened. Recorded in the activity detail only. */
		via?: "nudge" | "manual";
		/** Overwrite an EXISTING row only when its status is one of these. Omit to
		 *  overwrite any, which is right for a deliberate answer: moving UP the
		 *  ladder from `reached_out` to `coming`/`not_coming` is the whole point of
		 *  the feature, and a caller recording the member's answer must never be
		 *  blocked from it. Two callers move the other way and do need it:
		 *
		 *  - `setContacted` passes `["reached_out"]` so ticking "contacted" can
		 *    never demote a real answer back to "I asked them". Without it, an
		 *    officer working from a list that rendered a moment ago erases the
		 *    decline that arrived since — and because `unavailableMembers` is
		 *    `not_coming` only, that member silently drops off the meeting page's
		 *    Not Available list AND loses the warning in the assign picker, so the
		 *    VPE hands a role to someone who said they cannot come.
		 *  - `markComingOnSelfClaim` passes `["reached_out", "not_coming"]`, which
		 *    both skips the redundant write when the row already says `coming` and
		 *    makes that de-dup ATOMIC. It used to be a SELECT followed by an
		 *    upsert, and two concurrent claims by the same member both read "not
		 *    coming yet" and both logged.
		 *
		 *  Note the list names the statuses that may be REPLACED, not the ones that
		 *  may be written; a caller wanting "re-affirming the same rung still logs"
		 *  includes `args.status` in its own list. */
		demoteFrom?: readonly AttendancePlanStatus[];
	},
): Promise<{ ok: true; changed: boolean }> {
	const written = await database
		.insert(meetingAttendancePlan)
		.values({
			memberId: args.memberId,
			meetingId: args.meetingId,
			status: args.status,
		})
		.onConflictDoUpdate({
			target: [meetingAttendancePlan.memberId, meetingAttendancePlan.meetingId],
			// `now()` rather than `new Date()`: `created_at` defaults to the DATABASE
			// clock, and stamping this one from the Node process clock lets skew
			// between the app container and Railway's managed Postgres produce
			// `updated_at < created_at`, or order two app instances' writes wrongly.
			set: { status: args.status, updatedAt: sql`now()` },
			...(args.demoteFrom
				? { setWhere: inArray(meetingAttendancePlan.status, args.demoteFrom) }
				: {}),
		})
		.returning({ id: meetingAttendancePlan.id });

	// Nothing written ⇒ the guard refused the demotion. Log nothing: a `plan_set`
	// row for a change that did not happen is a lie the activity feed then tells
	// forever.
	if (written.length === 0) return { ok: true as const, changed: false };

	await logActivity(database, {
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "plan_set",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: {
			memberId: args.memberId,
			status: args.status,
			via: args.via ?? "manual",
		},
	});
	return { ok: true as const, changed: true };
}

/**
 * Back to "no answer" — deletes the row. Idempotent.
 *
 * `onlyFrom` is the delete-side twin of `setPlanStatus`'s `demoteFrom`, and it
 * is what stops a session-less caller destroying officer state. Before the
 * consolidation, erasing "I contacted them" meant deleting a row in the separate
 * outreach table, which took `requireUser()` + `requireClubRole(admin)`. That
 * fact now shares a row with the member's own answer, so a status-blind DELETE
 * reached through the PUBLIC `clearAvailability` would have let anyone wipe it —
 * the officer's chase list silently loses people and they get contacted twice.
 * Self-serve callers pass `SELF_SERVICE_RUNGS`; the admin-gated `clearContacted`
 * passes nothing and may clear any rung.
 */
export async function clearPlanStatus(
	database: DbOrTx,
	args: {
		memberId: string;
		meetingId: string;
		clubId: string;
		actorMemberId: string | null;
		/** Delete only when the current status is one of these. Omit to delete
		 *  whatever is there (officer-gated callers only). */
		onlyFrom?: readonly AttendancePlanStatus[];
	},
): Promise<{ ok: true; cleared: boolean }> {
	const removed = await database
		.delete(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, args.memberId),
				eq(meetingAttendancePlan.meetingId, args.meetingId),
				...(args.onlyFrom
					? [inArray(meetingAttendancePlan.status, args.onlyFrom)]
					: []),
			),
		)
		.returning({ id: meetingAttendancePlan.id });

	// No row removed ⇒ either there was nothing to clear, or the guard refused.
	// Either way nothing changed, so nothing is logged.
	if (removed.length === 0) return { ok: true as const, cleared: false };

	await logActivity(database, {
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "plan_set",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: { memberId: args.memberId, status: null },
	});
	return { ok: true as const, cleared: true };
}

/**
 * One member's rung for one meeting, or null for "no answer" (no row).
 *
 * Takes a `DbOrTx` like the writers so a caller inside a transaction reads its
 * OWN uncommitted state — `markComingOnSelfClaim` runs inside the claim's
 * transaction, and reading through the pool client there would see the world as
 * it was before the claim and could act on it.
 */
export async function getPlanStatus(
	database: DbOrTx,
	args: { memberId: string; meetingId: string },
): Promise<AttendancePlanStatus | null> {
	const [row] = await database
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, args.memberId),
				eq(meetingAttendancePlan.meetingId, args.meetingId),
			),
		)
		.limit(1);
	return row?.status ?? null;
}

/** Members marked `not_coming`, with names, for one meeting — ordered by name. */
export async function listNotComingWithNames(
	database: DbOrTx,
	meetingId: string,
): Promise<{ id: string; name: string }[]> {
	return database
		.select({ id: members.id, name: members.name })
		.from(meetingAttendancePlan)
		.innerJoin(members, eq(members.id, meetingAttendancePlan.memberId))
		.where(
			and(
				eq(meetingAttendancePlan.meetingId, meetingId),
				eq(meetingAttendancePlan.status, "not_coming"),
			),
		)
		.orderBy(members.name);
}

/** `not_coming` pairs across several meetings (season grid, recurrence check). */
export async function listNotComingForMeetings(
	database: DbOrTx,
	meetingIds: string[],
): Promise<{ memberId: string; meetingId: string }[]> {
	// Short-circuit: an empty `inArray` compiles to `false`, so this guard exists
	// to skip the round-trip, not to change the result.
	if (meetingIds.length === 0) return [];
	return database
		.select({
			memberId: meetingAttendancePlan.memberId,
			meetingId: meetingAttendancePlan.meetingId,
		})
		.from(meetingAttendancePlan)
		.where(
			and(
				inArray(meetingAttendancePlan.meetingId, meetingIds),
				eq(meetingAttendancePlan.status, "not_coming"),
			),
		);
}

/** Every plan row across several meetings, statuses included — the season grid
 *  needs both partitions from one round-trip. */
export async function listPlanForMeetings(
	database: DbOrTx,
	meetingIds: string[],
): Promise<
	{ memberId: string; meetingId: string; status: AttendancePlanStatus }[]
> {
	if (meetingIds.length === 0) return [];
	return database
		.select({
			memberId: meetingAttendancePlan.memberId,
			meetingId: meetingAttendancePlan.meetingId,
			status: meetingAttendancePlan.status,
		})
		.from(meetingAttendancePlan)
		.where(inArray(meetingAttendancePlan.meetingId, meetingIds));
}

/** `reached_out` member ids for one meeting — the old "contacted" set.
 *
 *  NO production caller since the panel landed: `meetings.ts` now takes the
 *  whole ladder in one `listPlanForMeetings` round trip and splits it. Kept
 *  deliberately, not stranded — this and `listComingForMeeting` are the seam's
 *  single-status readers, and `attendance-plan-store.guard.test.ts` requires
 *  every plan-table query to live in this module, so the next consumer that
 *  wants one status has somewhere to come rather than a reason to inline a
 *  query. Delete them only together with that need. */
export async function listReachedOutForMeeting(
	database: DbOrTx,
	meetingId: string,
): Promise<string[]> {
	return listMemberIdsWithStatus(database, meetingId, "reached_out");
}

/** `coming` member ids for one meeting. No pre-consolidation equivalent — the
 *  old pair could not express a positive answer at all — so every consumer of
 *  this is new, starting with the outreach panel, which would otherwise put a
 *  member who said yes into the "still to ask" list. */
export async function listComingForMeeting(
	database: DbOrTx,
	meetingId: string,
): Promise<string[]> {
	return listMemberIdsWithStatus(database, meetingId, "coming");
}

async function listMemberIdsWithStatus(
	database: DbOrTx,
	meetingId: string,
	status: AttendancePlanStatus,
): Promise<string[]> {
	const rows = await database
		.select({ memberId: meetingAttendancePlan.memberId })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.meetingId, meetingId),
				eq(meetingAttendancePlan.status, status),
			),
		);
	return rows.map((r) => r.memberId);
}

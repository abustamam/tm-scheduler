import { and, eq, inArray } from "drizzle-orm";
import type { db } from "#/db";
import {
	attendancePlanStatusEnum,
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
 * THE only module that reads or writes `meeting_attendance_plan`. Row absent =
 * "no answer"; there is no fourth enum value for it, because a row that means
 * "nothing is known" is a row every reader has to remember to ignore.
 *
 * `not_coming` is the sole encoding of "unavailable" in the database. Anything
 * asking "is this member out?" MUST come through here rather than testing for
 * row presence — the whole point of the consolidation is that presence no
 * longer answers that question.
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
	},
): Promise<{ ok: true }> {
	await database
		.insert(meetingAttendancePlan)
		.values({
			memberId: args.memberId,
			meetingId: args.meetingId,
			status: args.status,
		})
		.onConflictDoUpdate({
			target: [meetingAttendancePlan.memberId, meetingAttendancePlan.meetingId],
			set: { status: args.status, updatedAt: new Date() },
		});

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
	return { ok: true as const };
}

/** Back to "no answer" — deletes the row. Idempotent. */
export async function clearPlanStatus(
	database: DbOrTx,
	args: {
		memberId: string;
		meetingId: string;
		clubId: string;
		actorMemberId: string | null;
	},
): Promise<{ ok: true }> {
	await database
		.delete(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, args.memberId),
				eq(meetingAttendancePlan.meetingId, args.meetingId),
			),
		);

	await logActivity(database, {
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "plan_set",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: { memberId: args.memberId, status: null },
	});
	return { ok: true as const };
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

/** `reached_out` member ids for one meeting — the old "contacted" set. */
export async function listReachedOutForMeeting(
	database: DbOrTx,
	meetingId: string,
): Promise<string[]> {
	const rows = await database
		.select({ memberId: meetingAttendancePlan.memberId })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.meetingId, meetingId),
				eq(meetingAttendancePlan.status, "reached_out"),
			),
		);
	return rows.map((r) => r.memberId);
}

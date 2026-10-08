// The meeting write policy as SQL (#1134, #1129 Q3/Q5). `meeting-lifecycle.ts`
// owns WHICH statuses each write class refuses (`MEETING_WRITE_POLICY`); this
// module turns that table into a predicate a write puts in its own WHERE.
//
// Server-side only: it imports the schema. The pure half (`assertMeetingAccepts`)
// stays in `src/lib` so the meeting page can read the same policy.
//
// ## Why a predicate and not just a check
//
// A check reads a row and a statement reads the row as of its own start: a
// cancel or complete committed between the two is invisible to the check and
// visible to the statement. So the writers that matter put the policy IN the
// statement, as `meetingNotCancelled` (`slots-logic.ts`) does for the one
// status it knows. These helpers are that predicate, generalised to a write
// class, so adding a status changes `MEETING_WRITE_POLICY` and nothing here.
import {
	and,
	eq,
	exists,
	getTableName,
	notInArray,
	type SQL,
	sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { db } from "#/db";
import { type meetingStatusEnum, meetings } from "#/db/schema";
import {
	MEETING_WRITE_POLICY,
	type MeetingStatus,
	type MeetingWriteClass,
	type MeetingWriteOptions,
} from "#/lib/meeting-lifecycle";

// Either the main db client or a drizzle transaction, as in `slots-logic.ts`.
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

// ---------------------------------------------------------------------------
// The policy's status union must be the database's. `MeetingStatus` is written
// by hand because `meeting-lifecycle.ts` is client-safe and cannot import the
// schema. Add a value to `meetingStatusEnum` (or to `MeetingStatus`) without the
// other and the line below stops typechecking, so a status cannot reach the
// database without the policy having placed it.
// ---------------------------------------------------------------------------
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
type AssertTrue<T extends true> = T;
/** Exported only so `noUnusedLocals` accepts the assertion. Never use it. */
export type MeetingStatusMatchesEnum = AssertTrue<
	Equal<MeetingStatus, (typeof meetingStatusEnum.enumValues)[number]>
>;

/** The statuses `writeClass` refuses, minus the ones this writer accepts anyway. */
function refusedStatuses(
	writeClass: MeetingWriteClass,
	accept: MeetingWriteOptions["accept"],
): MeetingStatus[] {
	const row = MEETING_WRITE_POLICY[writeClass];
	const accepted: readonly string[] = accept ?? [];
	return (Object.keys(row) as MeetingStatus[]).filter(
		(status) => row[status] === "refuse" && !accepted.includes(status),
	);
}

/**
 * SQL predicate for a CHILD table's write, in its own WHERE: true while the
 * row's meeting accepts `writeClass` (minus `options.accept`). `meetingId` is
 * the child's column that points at the meeting, e.g. `roleSlots.meetingId`.
 *
 * Built with the query builder, the same shape as `meetingNotCancelled`, and
 * NOT a hand-written `sql` subquery: those can drop the column qualifier, and
 * a subquery whose two sides both resolve against its own table matches every
 * row (`drizzle-sql-subquery-drops-qualifiers`). The rendered SQL is pinned in
 * `meeting-write-gate.integration.test.ts`.
 *
 * Correlates by the meeting's id, so a meeting that is gone is refused too:
 * the write touches no row, and a caller that needs to say WHY re-reads the
 * status and calls `assertMeetingAccepts`, the way `assertMeetingNotCancelledOn`
 * does after `meetingNotCancelled`.
 *
 * It is not for a write to `meetings` itself: that would correlate `meetings`
 * against `meetings`, which needs an alias and is not offered. Passing
 * `meetings.id` throws; use `meetingRowAccepts`.
 */
export function meetingAcceptsWrite(
	conn: DbOrTx,
	writeClass: MeetingWriteClass,
	meetingId: AnyPgColumn,
	options?: Pick<MeetingWriteOptions, "accept">,
): SQL {
	if (getTableName(meetingId.table) === getTableName(meetings)) {
		throw new Error(
			"meetingAcceptsWrite is for a child table's meeting_id; use meetingRowAccepts for a write to meetings.",
		);
	}
	const refused = refusedStatuses(writeClass, options?.accept);
	return exists(
		conn
			.select({ one: sql`1` })
			.from(meetings)
			.where(
				refused.length === 0
					? eq(meetings.id, meetingId)
					: and(
							eq(meetings.id, meetingId),
							notInArray(meetings.status, refused),
						),
			),
	);
}

/**
 * For an UPDATE/DELETE on `meetings` itself: true while this row's own status
 * accepts `writeClass` (minus `options.accept`). No subquery: the row is the
 * meeting, so its own `status` column is the whole question.
 */
export function meetingRowAccepts(
	writeClass: MeetingWriteClass,
	options?: Pick<MeetingWriteOptions, "accept">,
): SQL {
	const refused = refusedStatuses(writeClass, options?.accept);
	return refused.length === 0
		? sql`true`
		: notInArray(meetings.status, refused);
}

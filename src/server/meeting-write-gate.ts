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
// statement, as `claimSlotCore`'s UPDATE and `removeOpenRoleSlots`' DELETE do
// (`slots-logic.ts`). These helpers are that predicate, generalised to a write
// class, so adding a status changes `MEETING_WRITE_POLICY` and nothing here.
//
// ## An allow-list, not a deny-list
//
// Both helpers say `status IN (accepted)`, never `status NOT IN (refused)`. The
// two agree on every status the policy knows. They differ on one it does not:
// `meetingRefusal` fails closed on it, and only the allow-list does too. A
// Postgres enum value cannot be dropped, so one added by a migration and then
// rolled back stays in the column's type, and a deny-list would let it write.
// The list is never empty, because `scheduled` is always accepted
// (`acceptedStatuses`).
import {
	and,
	eq,
	exists,
	getTableName,
	inArray,
	type SQL,
	sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { db } from "#/db";
import { type meetingStatusEnum, meetings } from "#/db/schema";
import {
	acceptedStatuses,
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

/**
 * SQL predicate for a CHILD table's write, in its own WHERE: true while the
 * row's meeting accepts `writeClass` (and any status in `options.accept`).
 * `meetingId` is the child's column that points at the meeting, e.g.
 * `roleSlots.meetingId`.
 *
 * Built with the query builder, and NOT a hand-written `sql` subquery: those
 * can drop the column qualifier, and a subquery whose two sides both resolve
 * against its own table matches every row
 * (`drizzle-sql-subquery-drops-qualifiers`). The rendered SQL is pinned in
 * `meeting-write-gate.integration.test.ts`.
 *
 * Correlates by the meeting's id, so a meeting that is gone is refused too:
 * the write touches no row, and a caller that needs to say WHY re-reads the
 * status and calls `assertMeetingAccepts`, the way `assertMeetingAcceptsOn`
 * (`slots-logic.ts`) does after a refused statement.
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
	return exists(
		conn
			.select({ one: sql`1` })
			.from(meetings)
			.where(
				and(
					eq(meetings.id, meetingId),
					inArray(
						meetings.status,
						acceptedStatuses(writeClass, options?.accept),
					),
				),
			),
	);
}

/**
 * For an UPDATE/DELETE on `meetings` itself: true while this row's own status
 * accepts `writeClass` (and any status in `options.accept`). No subquery: the
 * row is the meeting, so its own `status` column is the whole question.
 */
export function meetingRowAccepts(
	writeClass: MeetingWriteClass,
	options?: Pick<MeetingWriteOptions, "accept">,
): SQL {
	return inArray(
		meetings.status,
		acceptedStatuses(writeClass, options?.accept),
	);
}

/**
 * The wrappers (#1139, decision D1 in #1129): functions a writer may call IN
 * PLACE of a class helper, each keyed `src/server/<file>#<fn>` with the write
 * class it refuses by. A writer that calls one of these counts as refusing by
 * that class, so the refusal can live in one shared function (the minutes
 * handlers' `assertMinutesMeetingRecordable`) instead of being copied into
 * every writer.
 *
 * `meeting-writers.guard.test.ts` holds every entry to three things:
 *
 * - the key names a top-level function or const, so renaming a wrapper without
 *   re-pointing it here fails;
 * - its body (read comment-blind) calls `assertMeetingAccepts`,
 *   `meetingAcceptsWrite` or `meetingRowAccepts` with the class as a `"plan"` /
 *   `"record"` literal (or a same-file const holding one), or calls another
 *   wrapper of the same class listed here.
 *   A wrapper is a chain as often as not (`ensureAgendaDraft` calls
 *   `resolveAgendaDraft`), so every hop is listed, and two wrappers that only
 *   call each other end in nothing and fail;
 * - its body passes no `accept`. A writer with an override refuses directly or
 *   through the callers it names, never through a wrapper, so no override can
 *   hide inside a function many writers share.
 *
 * A function that does not appear here is not a refusal, however it is named:
 * a writer that relies on it fails the guard. A wrapper that passes `accept`
 * (the plan seam's `assertPlanMeetingAccepts`) cannot be listed, and its
 * writers are classified by hand.
 */
export const MEETING_WRITE_GATES: Readonly<Record<string, MeetingWriteClass>> =
	{
		"src/server/guest-book-recordable.ts#assertGuestBookMeetingRecordable":
			"record",
		"src/server/meeting-agenda-edit-logic.ts#ensureAgendaDraft": "plan",
		"src/server/meeting-agenda-edit-logic.ts#resolveAgendaDraft": "plan",
		"src/server/minutes.ts#assertMinutesMeetingRecordable": "record",
		"src/server/role-feedback-logic.ts#admitNote": "record",
		"src/server/voting-logic.ts#assertVoteMeetingAccepts": "plan",
	};

// The attendance panel's ROLL-mode rows, projected through the offline write
// queue (#176). PURE + CLIENT-ONLY.
//
// Why this is a `lib/` seam rather than an expression in the route: the meeting
// route cannot be mounted in jsdom (loader + server fns), so a derivation
// living there is testable by nothing but a source grep — and the observable
// here is behavioural, not textual ("a queued tap changes what the panel
// renders"). TYPE-ONLY imports of `#/server/minutes-logic` keep `#/db` (and so
// `pg`) out of the client bundle and out of this module's unit test.
import type { AttendanceStatus, MinutesData } from "#/server/minutes-logic";
import { deriveMinutes } from "./derive-minutes";
import type { MinutesOp } from "./offline-minutes-queue";

/** One RECORDED attendance row, in the shape the panel's `attendance` prop takes. */
export type RecordedAttendance = { memberId: string; status: AttendanceStatus };

/**
 * The recorded attendance rows the roll panel should show right now.
 *
 * Online, the server is the source of truth and the chip moves via the loader
 * refetch `offlineMinutes.mutate` triggers — deriving here would only race it.
 * Offline, the write is queued and no refetch will ever land, so the queue has
 * to be replayed over the last online snapshot or an officer taps "Present",
 * sees nothing move, and taps again. Same branch, same order, as
 * `meeting-minutes.tsx`'s `displayMinutes` (`online ? minutes :
 * deriveMinutes(snapshot ?? minutes, queue)`) — deliberately copied rather than
 * improved on, so the panel and the Minutes card cannot disagree about what is
 * recorded while the queue is draining.
 *
 * `status: null` rows are DROPPED, not flattened to a value: `buildRollPanel`
 * needs the ABSENCE of a row to render the plan's answer as a dashed
 * suggestion, so a member nobody has marked must not appear here at all.
 *
 * Returns `[]` when there is nothing to read from — `minutes` is `null` for a
 * viewer who may not read the minutes at all.
 */
export function deriveRollAttendance({
	online,
	minutes,
	snapshot,
	queue,
}: {
	online: boolean;
	minutes: MinutesData | null;
	snapshot: MinutesData | null;
	queue: MinutesOp[];
}): RecordedAttendance[] {
	const base = online ? minutes : (snapshot ?? minutes);
	if (!base) return [];
	const source = online ? base : deriveMinutes(base, queue);
	return source.members.flatMap((m) =>
		m.status === null ? [] : [{ memberId: m.memberId, status: m.status }],
	);
}

// The attendance panel's ROLL-mode rows — members AND guests — projected
// through the offline write queue (#176). PURE + CLIENT-ONLY.
//
// Why this is a `lib/` seam rather than an expression in the route: the meeting
// route cannot be mounted in jsdom (loader + server fns), so a derivation
// living there is testable by nothing but a source grep — and the observable
// here is behavioural, not textual ("a queued tap changes what the panel
// renders"). TYPE-ONLY imports of `#/server/minutes-logic` keep `#/db` (and so
// `pg`) out of the client bundle and out of this module's unit test.
import type {
	AttendanceStatus,
	MinutesData,
	MinutesGuestRow,
} from "#/server/minutes-logic";
import { deriveMinutes } from "./derive-minutes";
import type { MinutesOp } from "./offline-minutes-queue";

/** One RECORDED attendance row, in the shape the panel's `attendance` prop takes. */
export type RecordedAttendance = { memberId: string; status: AttendanceStatus };

/** What both projections read. One shape so the two cannot be called differently. */
type ProjectionInput = {
	online: boolean;
	minutes: MinutesData | null;
	snapshot: MinutesData | null;
	queue: MinutesOp[];
};

/**
 * The minutes the roll panel should be reading right now, or `null` if there is
 * nothing to read.
 *
 * Online, the server is the source of truth and the UI moves via the loader
 * refetch `offlineMinutes.mutate` triggers — deriving here would only race it.
 * Offline, the write is queued and no refetch will ever land, so the queue has
 * to be replayed over the last online snapshot. Same branch, same order, as
 * `meeting-minutes.tsx`'s `displayMinutes` (`online ? minutes :
 * deriveMinutes(snapshot ?? minutes, queue)`) — deliberately copied rather than
 * improved on, so the panel and the Minutes card cannot disagree about what is
 * recorded while the queue is draining.
 */
function projectMinutes({
	online,
	minutes,
	snapshot,
	queue,
}: ProjectionInput): MinutesData | null {
	const base = online ? minutes : (snapshot ?? minutes);
	if (!base) return null;
	return online ? base : deriveMinutes(base, queue);
}

/**
 * The recorded attendance rows the roll panel should show right now
 * (see `projectMinutes` for the online/offline branch).
 *
 * Without the projection an officer offline taps "Present", the write queues,
 * nothing moves, and they tap again — on the one surface #176's queue exists
 * for.
 *
 * `status: null` rows are DROPPED, not flattened to a value: `buildRollPanel`
 * needs the ABSENCE of a row to render the plan's answer as a dashed
 * suggestion, so a member nobody has marked must not appear here at all.
 *
 * Returns `[]` when there is nothing to read from — `minutes` is `null` for a
 * viewer who may not read the minutes at all.
 */
export function deriveRollAttendance(
	input: ProjectionInput,
): RecordedAttendance[] {
	const source = projectMinutes(input);
	if (!source) return [];
	return source.members.flatMap((m) =>
		m.status === null ? [] : [{ memberId: m.memberId, status: m.status }],
	);
}

/**
 * The guest rows the roll panel should show right now — the same projection,
 * one control to the right.
 *
 * Fix round 2 (F3): the route used to pass `minutes.data?.guests` raw, which
 * left the guests exactly where the chips were before F1, and worse in one
 * respect. `AttendanceGuestsGroup` holds no internal optimism, so offline an
 * added guest simply did not appear — AND its already-present filter
 * (`presentIds`, built from this same list) kept OFFERING that guest in the
 * picker, inviting the second tap this whole round exists to kill.
 * `deriveMinutes` already replays `addGuest` / `removeGuest`, so the projection
 * existed and was merely unused here. It matters most for Task 6: once the
 * Minutes `AttendanceSection` is deleted, this is the only surface that can show
 * an offline guest write at all.
 *
 * Returns `undefined`, NOT `[]`, when there is nothing to read from — unlike
 * `deriveRollAttendance` above, and deliberately: the panel's `guests` prop is
 * optional so that a caller which has not wired guests renders NOTHING rather
 * than an empty "Guests" group, and `[]` here would quietly turn that into an
 * empty group for any viewer whose `minutes.data` is null.
 */
export function deriveRollGuests(
	input: ProjectionInput,
): MinutesGuestRow[] | undefined {
	return projectMinutes(input)?.guests;
}

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
import { type buildPlanPanel } from "./attendance-panel";
import { deriveMinutes } from "./derive-minutes";
import type { MinutesOp } from "./offline-minutes-queue";

/** One RECORDED attendance row, in the shape the panel's `attendance` prop takes. */
export type RecordedAttendance = { memberId: string; status: AttendanceStatus };

/** Exactly the panel's `roster` prop shape — DERIVED from the function it is
 *  handed to, never a second hand-listed `Omit`. It read
 *  `Omit<PanelMember, "status" | "roleName">`, and when `roleName` was replaced
 *  by `role`/`storedStatus`/`assumed` (v1.19.0.0, #594) that omit went stale in
 *  silence: `Omit` does not constrain its keys, so omitting a field that no
 *  longer exists is legal, and the three NEW fields simply became REQUIRED of
 *  every roster row — including the departed rows appended below, which cannot
 *  supply them. The comment here used to claim this "cannot drift"; the
 *  hand-listed omit is exactly what let it. Same fix `buildPlanPanel`'s own
 *  caller took, for the same reason. */
export type RollRosterRow = Parameters<
	typeof buildPlanPanel
>[0]["roster"][number];

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

/**
 * The roster ROLL mode should render: the active roster, PLUS anyone who has a
 * recorded attendance row for this meeting but is no longer on it.
 *
 * `loadMinutes` deliberately builds its member list the same way — "active
 * roster ∪ any member with a saved attendance row" (`minutes-logic.ts`) — and
 * `minutes.counts` is computed over that union. Roll mode was built from the
 * active roster alone, which is RIGHT for an upcoming meeting (a stale row must
 * not resurrect a departed name on a ladder nobody has answered yet, which is
 * what `buildRollPanel` guarantees and `roll-panel.test.ts` pins) and WRONG for
 * the completed meetings roll mode also serves: a member marked present in
 * March who leaves the club in April vanished from May's reopened minutes. Their
 * row could not be seen or corrected anywhere in the app — the Minutes card's
 * own recorder is gone — and the panel's counts line disagreed with the Minutes
 * card, the PDF and the emailed minutes for the same meeting, because
 * `loadMinutes` counted that member and the panel did not.
 *
 * Fixed HERE rather than in `buildRollPanel`, which is correct as written: it
 * builds from whatever roster it is handed. This is the seam that decides which
 * roster that is.
 *
 * The appended rows are CONTACT-LESS — a departed member's phone and email are
 * not on the officer's roster payload — and they are TAGGED `departed: true` for
 * exactly that reason. Nulling contact is not enough on its own: `NudgeButtons`
 * renders "No contact on file" when both are null, which is the copy the panel
 * omits the whole affordance to avoid. The tag is what lets the row skip it while
 * leaving that message intact for an ACTIVE member who genuinely has no contact
 * stored — for them it is true and actionable, and for a departed member there is
 * nothing to add and nobody to chase. Same projection as the other two
 * derivations, so an offline tap on such a row behaves like any other.
 *
 * A member with NO recorded status is never appended: absence of a row is
 * exactly what "not on this club's roster any more" looks like, and appending
 * them would resurrect the name this guards against.
 *
 * Returns the input array UNCHANGED (same identity) when nothing is appended —
 * the common case by far, and it keeps the panel's `roster` prop stable across
 * renders.
 */
export function deriveRollRoster(
	input: ProjectionInput & { roster: RollRosterRow[] },
): RollRosterRow[] {
	const source = projectMinutes(input);
	if (!source) return input.roster;
	const onRoster = new Set(input.roster.map((m) => m.id));
	const departed = source.members.flatMap((m) =>
		m.status === null || onRoster.has(m.memberId)
			? []
			: [
					{
						id: m.memberId,
						name: m.name,
						preferredName: null,
						phone: null,
						email: null,
						departed: true,
					},
				],
	);
	return departed.length === 0 ? input.roster : [...input.roster, ...departed];
}

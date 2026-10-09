// Meeting lifecycle helpers (issue #150). A meeting moves
// `scheduled → completed` (admin "Complete") and back `completed → scheduled`
// (admin "Reopen"). A completed meeting is LOCKED: every agenda mutation is
// rejected server-side. These pure helpers are client-safe (no `#/db`) so both
// the server-side lock and the read-only UI can share them.
import { utcToZonedWallTime } from "./datetime";
import {
	isMeetingCancelled,
	MEETING_CANCELLED_MESSAGE,
} from "./meeting-cancellation-notice";
import { type MeetingViewer, meetingViewer } from "./meeting-viewer";

/** The exact banner/lock copy shown on a completed meeting. */
export const MEETING_LOCKED_MESSAGE = "This meeting is locked.";

/**
 * What a PREVIEW says about a completed meeting, as a blocking item, and
 * deliberately NOT `MEETING_LOCKED_MESSAGE` above.
 *
 * The two say different things on purpose: the banner is what a reader sees on
 * a locked meeting, and this is what a plan says about a change it will not
 * make. #806's lesson is the reason they must stay distinct — a guard inside a
 * locked transaction is unreachable by a serial test when a cheaper pre-check
 * answers first, and doubly so when both refusals say the same words.
 *
 * It lives HERE, beside `isMeetingLocked`, because the lock is not one tool's
 * idea. `assign_roles` declared it first (#809) and `upsert_agendas` raises the
 * same item for the same fact (#808); a second tool importing it out of the
 * first tool's planner made #808 depend on #809 for a sentence about neither.
 * `assign-roles-plan.ts` re-exports it, so no importer of that module had to be
 * edited in the change that moved it — `export … from`, not a wrapper, so the
 * two spellings cannot drift into two sentences.
 */
export const MEETING_LOCKED_BLOCKING_MESSAGE =
	"That meeting is completed, so its agenda no longer accepts changes.";

/**
 * Rejection copy for recording attendance before the meeting day.
 *
 * Attendance is the RECORD of who was in the room, so it cannot exist for a
 * meeting that has not happened. Who is EXPECTED is a different question with
 * its own table — see CONTEXT.md's **Planned attendance** entry. Writing a plan
 * into the record is the confusion this message exists to stop, and it matters
 * because `meeting_attendance` feeds the minutes PDF, the minutes email and the
 * reporting derivations.
 */
export const ATTENDANCE_BEFORE_MEETING_MESSAGE =
	"Attendance can't be recorded before the meeting day.";

/** True when the meeting is completed (locked, read-only). */
export function isMeetingLocked(status: string): boolean {
	return status === "completed";
}

/**
 * The meeting write policy (#1134, decided in #1129 Q3/Q5): a writer refuses a
 * frozen meeting by WRITE CLASS, not by hand-picking `assertMeetingNotCancelled`
 * or `assertMeetingNotLocked`, and this one table says which statuses each class
 * refuses. A new status is then one edit here, not an audit of every writer.
 *
 * - `plan`: what is intended for a meeting that has not happened (the agenda,
 *   its meta, role claims and assignments, and the vote window with its
 *   ballots and rulings, which close when the meeting completes). Refused once
 *   the meeting is cancelled or completed.
 * - `record`: what is written about a meeting after it happened (attendance,
 *   minutes, awards). Refused on a cancelled meeting, which never happened,
 *   and accepted on a completed one, which is when it is written up.
 *
 * Client-safe (no schema import), like everything in this module, so the
 * `MeetingStatus` union below is HAND-WRITTEN. `meeting-write-gate.ts`, which
 * may import the schema, asserts at the type level that it equals
 * `meetingStatusEnum`'s values, so the two cannot drift apart.
 */
export type MeetingStatus = "scheduled" | "cancelled" | "completed";
/** Every status that is not `scheduled`: the ones a write class can refuse. */
export type FrozenMeetingStatus = Exclude<MeetingStatus, "scheduled">;
export type MeetingWriteClass = "plan" | "record";

/**
 * Which statuses each write class refuses. Adding a status to `MeetingStatus`
 * fails typecheck here until it is placed in both rows, and in
 * `REFUSAL_MESSAGE` below. `scheduled` is typed as `"accept"` alone: a meeting
 * that has not been frozen is never refused, and `meetingRefusal`'s
 * `FrozenMeetingStatus` return type rests on it.
 */
export const MEETING_WRITE_POLICY: Record<
	MeetingWriteClass,
	{ scheduled: "accept" } & Record<FrozenMeetingStatus, "accept" | "refuse">
> = {
	plan: { scheduled: "accept", cancelled: "refuse", completed: "refuse" },
	record: { scheduled: "accept", cancelled: "refuse", completed: "accept" },
};

/** The sentence a refused status says when the writer gives no copy of its own. */
const REFUSAL_MESSAGE: Record<FrozenMeetingStatus, string> = {
	cancelled: MEETING_CANCELLED_MESSAGE,
	completed: MEETING_LOCKED_MESSAGE,
};

/**
 * The refused status, or null when the class accepts it. An unknown status
 * throws (fail closed): a status this table has never heard of is not one a
 * write may assume is fine, and `status` arrives as a bare string from every
 * caller. `hasOwn` rather than `in`, so `"toString"` is unknown, not accepted.
 */
export function meetingRefusal(
	status: string,
	writeClass: MeetingWriteClass,
): FrozenMeetingStatus | null {
	const row = MEETING_WRITE_POLICY[writeClass];
	if (!Object.hasOwn(row, status)) {
		throw new Error(`Unknown meeting status: ${status}`);
	}
	const known = status as MeetingStatus;
	if (row[known] === "accept") return null;
	// `scheduled` is typed `"accept"`, so a refused status is a frozen one.
	return known as FrozenMeetingStatus;
}

export interface MeetingWriteOptions {
	/** Replaces the refusal sentence for a status, so a writer keeps its current copy. */
	messages?: Partial<Record<FrozenMeetingStatus, string>>;
	/** A per-writer override (#1129 Q3): statuses this writer accepts although its class refuses them. */
	accept?: readonly FrozenMeetingStatus[];
}

/**
 * Throw the refused status's message: `options.messages[status]` when given,
 * else `MEETING_CANCELLED_MESSAGE` / `MEETING_LOCKED_MESSAGE`. A status in
 * `options.accept` is not refused. Pure: call with the status a write already
 * loaded. The unknown-status check runs even for an accepted status, so an
 * override cannot turn a fail-closed refusal into a pass.
 */
export function assertMeetingAccepts(
	status: string,
	writeClass: MeetingWriteClass,
	options: MeetingWriteOptions = {},
): void {
	const refused = meetingRefusal(status, writeClass);
	if (refused === null || options.accept?.includes(refused)) return;
	throw new Error(options.messages?.[refused] ?? REFUSAL_MESSAGE[refused]);
}

/**
 * The statuses a write of `writeClass` accepts, plus any the writer accepts
 * anyway (`options.accept`), in policy order. `scheduled` is always among them.
 *
 * The SQL helpers in `src/server/meeting-write-gate.ts` filter on THIS list
 * (`status IN (...)`), not on the refused one (`status NOT IN (...)`). The
 * difference is a status the policy has never heard of: `meetingRefusal` fails
 * closed on it, and an allow-list does the same in the statement, where a
 * deny-list would let it through. It can happen: a Postgres enum value cannot
 * be dropped, so one added by a migration and then rolled back stays in the
 * enum for good. Pure and client-safe, so the accept-filtering is covered
 * without a database.
 */
export function acceptedStatuses(
	writeClass: MeetingWriteClass,
	accept: MeetingWriteOptions["accept"] = [],
): MeetingStatus[] {
	const row = MEETING_WRITE_POLICY[writeClass];
	const alsoAccepted: readonly string[] = accept;
	return (Object.keys(row) as MeetingStatus[]).filter(
		(status) => row[status] === "accept" || alsoAccepted.includes(status),
	);
}

/**
 * Whether a meeting's scheduled *date* is today or in the past, in the club's
 * timezone. "Complete" is only offered/allowed once this is true — a future
 * meeting cannot be locked. Compared at day granularity (a meeting earlier
 * today is completable even before its wall-clock start).
 */
export function meetingDateReached(
	scheduledAt: Date | string,
	timezone: string,
	now: Date = new Date(),
): boolean {
	const day = utcToZonedWallTime(new Date(scheduledAt), timezone).slice(0, 10);
	const today = utcToZonedWallTime(now, timezone).slice(0, 10);
	// YYYY-MM-DD strings compare lexicographically in chronological order.
	return day <= today;
}

/**
 * Whether a meeting's scheduled *date* is strictly before today, in the club's
 * timezone. Unlike `meetingDateReached`, the meeting day itself is NOT past — so
 * the public agenda stays editable the day of the meeting (people fill roles
 * right up to it) and only flips to read-only/attendance the day after.
 */
export function meetingDatePassed(
	scheduledAt: Date | string,
	timezone: string,
	now: Date = new Date(),
): boolean {
	const day = utcToZonedWallTime(new Date(scheduledAt), timezone).slice(0, 10);
	const today = utcToZonedWallTime(now, timezone).slice(0, 10);
	return day < today;
}

/**
 * THE "is this meeting over?" rule (#393) — one definition, every surface.
 *
 * Over = the meeting is completed (locked), OR its scheduled DAY is strictly
 * past in the club's timezone. **Club-local day granularity, not an instant:**
 * the agenda stays live all day so people can fill roles right up to — and
 * during — the meeting, and only freezes the next club-local day. `now` is
 * injectable so every consumer on a page can be pinned to the same clock (the
 * viewer and the panels must never read the wall clock separately); omit it for
 * the live clock.
 *
 * NOT the same predicate as the past/upcoming LISTING split — `loadPastMeetings`
 * (`scheduledAt < now`), `listUpcomingMeetings` (`scheduledAt >= now`), and the
 * season grid's `isPast`. Those are exact complements on the INSTANT axis and
 * must stay that way: a meeting that started an hour ago has already left
 * "upcoming", so an archive built on this day-granularity rule would leave it in
 * NEITHER list until midnight, unreachable from both. Listing answers "which
 * side of now is it"; `isMeetingOver` answers "is the planning window closed".
 * They deliberately disagree between a meeting's start time and the end of its
 * club-local day. Do not unify them.
 */
export function isMeetingOver(input: {
	status: string;
	scheduledAt: Date | string;
	timezone: string;
	now?: Date;
}): boolean {
	return (
		isMeetingLocked(input.status) ||
		meetingDatePassed(input.scheduledAt, input.timezone, input.now)
	);
}

/** The meeting's UI phase (#541 D1): upcoming, today, or completed. */
export type MeetingPhase = "upcoming" | "today" | "completed";

/**
 * The meeting's UI phase (#541 D1). Phases re-weight the chrome — they NEVER
 * hide a capability. In PR 1 the only weighting wired up is WHICH ACTION IS
 * PRIMARY (`MeetingToolbar`), plus the Minutes anchor gate. The spec's other
 * two phase effects are NOT implemented yet and there is no code to find:
 * Confirm loudness / `CONFIRM_WINDOW_HOURS` (D5) lands in PR 2, and
 * minutes/outreach phase gating (D6) in PR 3. Delegates its completed arm to `isMeetingOver`
 * (#393) rather than re-deriving locked-or-passed, so chrome phase cannot
 * desync from the agenda freeze. Same club-local day granularity and
 * injectable `now` as every helper above; a passed-but-never-completed
 * meeting is "completed" (recording what happened is the page's job there),
 * while `resolveMeetingViewer` still lets an admin edit it until they press
 * Complete — weight and capability are deliberately separate axes.
 */
export function meetingPhase(input: {
	status: string;
	scheduledAt: Date | string;
	timezone: string;
	now?: Date;
}): MeetingPhase {
	const now = input.now ?? new Date();
	if (isMeetingOver({ ...input, now })) return "completed";
	if (meetingDateReached(input.scheduledAt, input.timezone, now))
		return "today";
	return "upcoming";
}

/**
 * A locked meeting's viewer (#150): keep the member identity but deny every
 * mutation capability, so the shared `<MeetingAgenda>` renders read-only. Used
 * by both meeting surfaces when `isMeetingLocked(status)` or the meeting is
 * cancelled (#1090).
 */
export function lockedViewer(v: MeetingViewer): MeetingViewer {
	return {
		currentMemberId: v.currentMemberId,
		canManage: false,
		canAssign: false,
		canReassignHeld: false,
		canManageSpeakers: false,
		canToggleAvailability: false,
		canTakeOver: false,
		canEditOwnSpeech: false,
		canClaim: false,
		canReleaseOwn: false,
		canEditMeetingMeta: false,
		canEditWod: false,
		canEditTableTopicsNotes: false,
	};
}

/**
 * Resolve the single viewer both meeting audiences share (#317). Encodes the one
 * asymmetry between the manager and self-serve paths: an admin keeps editing a
 * past-but-open meeting until they Complete it, while a member/anon agenda
 * freezes once the meeting date passes. A completed (locked) or cancelled
 * meeting is read-only for everyone. Pure + injectable `now` so it is deterministically
 * testable. Both `<MeetingAgenda>` surfaces build their viewer through this.
 */
export function resolveMeetingViewer(input: {
	status: string;
	scheduledAt: Date | string;
	timezone: string;
	currentMemberId: string | null;
	canManage: boolean;
	isTmod: boolean;
	isGrammarian: boolean;
	isSignedIn: boolean;
	/** Optional, fail closed — see `meetingViewer`. */
	isTableTopicsMaster?: boolean;
	now?: Date;
}): MeetingViewer {
	const locked = isMeetingLocked(input.status);
	const over = isMeetingOver(input);
	// A cancelled meeting (#1057/#1090) is read-only for everyone, officers
	// included: the server refuses every claim, assignment and edit on it, so the
	// viewer must not offer one. Restore and View notice key off the route's
	// `effectiveCanManage`, not this viewer, so they are unaffected.
	const cancelled = isMeetingCancelled(input.status);
	// Managers edit until Complete (locked) or Cancel; members/anon freeze once `over`.
	const editable = !cancelled && (input.canManage ? !locked : !over);
	const base = meetingViewer({
		currentMemberId: input.currentMemberId,
		canManage: input.canManage,
		isTmod: input.isTmod,
		isGrammarian: input.isGrammarian,
		isEditableWindow: editable,
		isSignedIn: input.isSignedIn,
		isTableTopicsMaster: input.isTableTopicsMaster,
	});
	return editable ? base : lockedViewer(base);
}

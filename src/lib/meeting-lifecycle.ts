// Meeting lifecycle helpers (issue #150). A meeting moves
// `scheduled → completed` (admin "Complete") and back `completed → scheduled`
// (admin "Reopen"). A completed meeting is LOCKED: every agenda mutation is
// rejected server-side. These pure helpers are client-safe (no `#/db`) so both
// the server-side lock and the read-only UI can share them.
import { utcToZonedWallTime } from "./datetime";
import type { MeetingViewer } from "./meeting-viewer";

/** The exact banner/lock copy shown on a completed meeting. */
export const MEETING_LOCKED_MESSAGE = "This meeting is locked.";

/** True when the meeting is completed (locked, read-only). */
export function isMeetingLocked(status: string): boolean {
	return status === "completed";
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
 * A locked meeting's viewer (#150): keep the member identity but deny every
 * mutation capability, so the shared `<MeetingAgenda>` renders read-only. Used
 * by both meeting surfaces when `isMeetingLocked(status)`.
 */
export function lockedViewer(v: MeetingViewer): MeetingViewer {
	return {
		currentMemberId: v.currentMemberId,
		canManage: false,
		canAssign: false,
		canManageSpeakers: false,
		canToggleAvailability: false,
		canTakeOver: false,
		canEditOwnSpeech: false,
		canClaim: false,
		canReleaseOwn: false,
		canEditMeetingMeta: false,
		canEditWod: false,
	};
}

// src/lib/vote-window.ts
//
// The automatic window in which a category's ballot is open with nobody having
// tapped "Open voting" (#1472).
//
// Pure, with no `#/db` import (same rule as `guest-book-window.ts`), so a unit
// test can assert the boundaries. ABSOLUTE time on purpose: `clubs.timezone`
// is often left at its `America/Chicago` default (#319), so a calendar-day rule
// would open and close the ballot at the wrong hour for most clubs.
import { APP_LOCALE } from "./format";
import { GUEST_BOOK_GRACE_AFTER_MS } from "./guest-book-window";

/** How long after the meeting's planned end a ballot stays open on its own. */
export const VOTE_GRACE_AFTER_MS = GUEST_BOOK_GRACE_AFTER_MS;

export interface AutoVoteWindow {
	opensAt: Date;
	closesAt: Date;
}

/** `[opensAt, closesAt)`: opens at the scheduled start, closes 60 minutes after
 *  the planned end. All three award categories share it. */
export function autoVoteWindow(
	scheduledAt: Date,
	lengthMinutes: number,
): AutoVoteWindow {
	const start = scheduledAt.getTime();
	return {
		opensAt: new Date(start),
		closesAt: new Date(start + lengthMinutes * 60 * 1000 + VOTE_GRACE_AFTER_MS),
	};
}

/** `opensAt <= now < closesAt`. */
export function isInAutoVoteWindow(w: AutoVoteWindow, now: Date): boolean {
	const t = now.getTime();
	return t >= w.opensAt.getTime() && t < w.closesAt.getTime();
}

/**
 * A window time as the phone or laptop in the room reads it: the DEVICE's own
 * zone, since the device is in the room and `clubs.timezone` is often left at
 * its default. Only call it from client-only renders (a polled query): the
 * server's zone is not the viewer's.
 */
export function formatVoteTime(d: Date): string {
	return d.toLocaleTimeString(APP_LOCALE, {
		hour: "numeric",
		minute: "2-digit",
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	});
}

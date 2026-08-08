// src/lib/guest-book-window.ts
//
// When a guest-book signature counts as ATTENDANCE at a meeting, rather than as
// an advance "planning to visit" sign-up (#319).
//
// The numbers live here, not beside the query in `guest-pipeline-logic.ts`,
// because that module imports `#/db` at load — a unit test importing it throws
// `DATABASE_URL is not set`, which makes any constant defined there
// unassertable. Same rule as `speaker-limits.ts` / `minutes-render-caps.ts`.

/**
 * How early a signature still counts as "at the meeting".
 *
 * The VP-Membership officer opens the guest book to set up before the meeting
 * starts, and guests arrive early — the #374 comment cites "the VPM opens VP
 * Membership at 18:45 for a 19:00 meeting". 90 minutes covers setup and early
 * arrivals without reaching back to a previous day's meeting.
 */
export const GUEST_BOOK_GRACE_BEFORE_MS = 90 * 60 * 1000;

/**
 * How late a signature still counts. Guests mingle after the close, and the
 * officer may not circulate the QR code until the end.
 *
 * Deliberately shorter than the before-grace: a signature hours after the room
 * emptied is far more likely to be someone who followed the "Planning a visit?"
 * link from the public club page than someone still standing there.
 */
export const GUEST_BOOK_GRACE_AFTER_MS = 60 * 60 * 1000;

/**
 * Is `now` inside the window where a signature means "I am here"?
 *
 * An ABSOLUTE-time window, deliberately, rather than the club-local calendar-day
 * comparison this replaced. That comparison was wrong in both directions:
 *
 *  - It dropped real visits. `clubs.timezone` defaults to `America/Chicago` and
 *    NOTHING in the product ever writes it (`onboarding-logic.ts` inserts a club
 *    with name/slug/clubNumber only), so a Pacific club's 19:00 meeting and a
 *    guest signing at 22:10 local fall on different Chicago dates — no
 *    attendance row at all, and VP-Membership then shows "No recorded visits"
 *    for someone who was in the room.
 *  - It still recorded absent people. A date-key match ignores the clock, so a
 *    guest following the public CTA at 21:35 was stamped `present` at a meeting
 *    that ended at 21:00 — the same minutes pollution the gate exists to stop.
 *
 * A window keyed on the meeting's own start and length depends on neither the
 * club's timezone nor the calendar, so both failure modes disappear.
 */
export function isAtMeetingNow(
	scheduledAt: Date,
	lengthMinutes: number,
	now: Date,
): boolean {
	const start = scheduledAt.getTime();
	const end = start + lengthMinutes * 60 * 1000;
	const t = now.getTime();
	return (
		t >= start - GUEST_BOOK_GRACE_BEFORE_MS &&
		t <= end + GUEST_BOOK_GRACE_AFTER_MS
	);
}

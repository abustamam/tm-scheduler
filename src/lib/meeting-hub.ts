/**
 * The meeting page "in the room" (#913).
 *
 * The printed agenda carries ONE QR, and it opens the public meeting page with
 * `?room=1`. On the meeting's own day that flag adds a short strip of live calls
 * to action above the page (`MeetingRoomStrip`): Vote while a category is open,
 * the person's own duty page or the guest book, the Word of the Day, and a jump
 * to the agenda. On any other day the flag is ignored, so a printed agenda kept
 * in a bag still opens a normal page.
 *
 * Pure and `#/db`-free so the print route, the meeting route and the tests
 * import the same functions.
 */

/** The search key the QR sets. */
export const MEETING_ROOM_PARAM = "room";

/** The in-page anchor the strip's "Today's agenda" button scrolls to. One
 *  constant, read by the strip's link and by the route's section id, so the
 *  two cannot drift apart silently (a string hash is invisible to typecheck). */
export const MEETING_AGENDA_ANCHOR_ID = "agenda";

/**
 * The URL the printed agenda's QR encodes — the meeting page, in the room.
 *
 * The same `origin` contract as `ballotUrlFor` (`#/lib/digital-voting`), minus
 * its voting gate: the strip is useful to a club that votes on paper too, so
 * this is never null.
 * - `null` — origin not known yet (first client render, before an effect reads
 *   `window.location`). Answers `""`, which every QR renderer here treats as
 *   "no code yet" rather than printing one that scans to nothing.
 * - `""` — deliberately relative. Answers the bare path.
 * - an origin — the absolute URL a phone's camera can resolve.
 */
function meetingPath(meeting: { clubKey: string; meetingKey: string }): string {
	return `/club/${meeting.clubKey}/meeting/${meeting.meetingKey}`;
}

export function meetingHubUrlFor(
	meeting: { clubKey: string; meetingKey: string },
	origin: string | null,
): string {
	if (origin === null) return "";
	return `${origin}${meetingPath(meeting)}?${MEETING_ROOM_PARAM}=1`;
}

/**
 * The anonymous feedback page's URL (#1282), encoded by the presenter view's QR
 * on the General Evaluation slide. Same `origin` contract as `meetingHubUrlFor`:
 * `null` answers `""` ("no code yet"), `""` answers the bare path.
 */
export function meetingFeedbackUrlFor(
	meeting: { clubKey: string; meetingKey: string },
	origin: string | null,
): string {
	if (origin === null) return "";
	return `${origin}${meetingPath(meeting)}/feedback`;
}

/**
 * The meeting route's search. `room` is typed `string | number` because the
 * router's default search parser JSON-decodes each value: `?room=1` arrives as
 * the NUMBER 1, not the string "1".
 */
export interface MeetingRoomSearch {
	room?: string | number;
	/** The page's tab (#1582). Read, never coerced: see the validator below. */
	tab?: string | number;
}

/**
 * The meeting route's `validateSearch`. It returns the parsed search object
 * UNCHANGED — same keys, same values, same reference.
 *
 * That is the whole contract, not laziness: TanStack Start's SSR answers with a
 * 307 to a re-serialised URL whenever `validateSearch`'s output differs from the
 * parsed search. Coercing `room` to a string would re-serialise `?room=1` as
 * `?room=%221%22` and bounce every scan through a redirect; dropping keys it
 * does not own would strip whatever else the URL carried (`?from=share`). So
 * nothing is coerced here, and `isInRoom` does the reading.
 */
export function validateMeetingRoomSearch(
	search: Record<string, unknown>,
): MeetingRoomSearch {
	return search as MeetingRoomSearch;
}

/** Whether the URL carries the QR's flag. Accepts both spellings the router can
 *  hand over: the number a default parse produces and the string a hand-built
 *  `search` object may carry. */
export function isInRoom(search: MeetingRoomSearch): boolean {
	return search.room === 1 || search.room === "1";
}

/** The search key that names the meeting page's tab (#1582). */
export const MEETING_TAB_PARAM = "tab";

export type MeetingTab = "roles" | "attendance" | "ballots" | "minutes";

/**
 * The tabs a viewer is offered, in the one fixed order: Roles, Attendance,
 * Ballots, Minutes. Roles is always first and always there. The three gates are
 * the conditions that decide today whether each section renders at all, so a
 * tab can never offer a section the viewer does not already get.
 */
export function meetingTabsFor(gates: {
	attendance: boolean;
	ballots: boolean;
	minutes: boolean;
}): MeetingTab[] {
	const tabs: MeetingTab[] = ["roles"];
	if (gates.attendance) tabs.push("attendance");
	if (gates.ballots) tabs.push("ballots");
	if (gates.minutes) tabs.push("minutes");
	return tabs;
}

/**
 * The tab the URL names, among those offered. Absent, unknown, non-string and
 * not-offered values all answer `"roles"`: a link to a tab this viewer is not
 * offered shows the page as they would otherwise see it, with no redirect.
 */
export function meetingTabFrom(
	search: MeetingRoomSearch,
	offered: MeetingTab[],
): MeetingTab {
	const value = search.tab;
	if (typeof value !== "string") return "roles";
	const match = offered.find((t) => t === value);
	return match ?? "roles";
}

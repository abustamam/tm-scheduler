/**
 * The next meeting, as the projected deck's "What's on tap" slide shows it
 * (#932). Pure and client-safe: the server builds it
 * (`#/server/next-meeting-summary-logic`), the present route carries it, and
 * both deck builders turn it into a slide.
 *
 * ## What it may carry
 *
 * NAMES ONLY. The slide is projected onto a wall and exported to a `.pptx` that
 * gets forwarded into club chat, so it lives under the same rule as every other
 * in-room artifact (#731/#754): no video-call link, no email, no phone. The
 * type is the first half of that; `inRoomNextMeeting`
 * (`#/lib/in-room-meeting-payload`) is the allowlist that projects it before it
 * reaches the served document, and the in-room payload guard under
 * `src/routes/` asserts over what ships.
 */
import { assigneeDisplayName } from "./agenda";

/** One role on the next meeting, all its places together. */
export type NextMeetingRole = {
	/** The club's own name for the role. */
	label: string;
	/** Who holds its places, in slot order. Empty when nobody does. */
	names: string[];
	/** How many of its places are unclaimed. */
	openCount: number;
};

export type NextMeetingSummary = {
	scheduledAt: Date | string;
	location: string | null;
	theme: string | null;
	/** The number to display (stored or derived), null when the club numbers none. */
	meetingNumber: number | null;
	/** The next meeting's canonical URL key (club-local date, `-HHmm` on a day
	 *  with two meetings), for the sign-up QR. */
	urlKey: string;
	/** The Toastmaster of the Day's role, or null when that meeting runs none
	 *  (a contest). Held apart from `roles` because the slide leads with it. */
	toastmaster: NextMeetingRole | null;
	/** Every OTHER role, in agenda order (role sort order, then slot index). */
	roles: NextMeetingRole[];
};

/** The slot fields the grouping reads — satisfied by `loadMeetingSlots`' rows. */
export type SummarySlot = {
	roleDefinitionId: string;
	roleName: string;
	roleKey: string | null;
	assigneeName: string | null;
	assigneeIsGuest?: boolean;
};

const TOASTMASTER_KEY = "toastmaster_of_the_day";
const TOASTMASTER_NAME = "toastmaster of the day";

/** The Toastmaster by stable key, falling back to the name for a role with no
 *  key — the same binding rule `matchesRole` gives the run sheet. */
const isToastmaster = (s: SummarySlot) =>
	s.roleKey != null
		? s.roleKey === TOASTMASTER_KEY
		: s.roleName.toLowerCase() === TOASTMASTER_NAME;

/**
 * Group slots into roles, keeping the order they arrive in.
 *
 * Callers pass `loadMeetingSlots`' rows, already ordered by role sort order and
 * then slot index, which is the order the agenda lists roles in. Grouped by
 * role DEFINITION, not by name, so two roles a club happened to name alike stay
 * two rows.
 */
export function summarizeRoles(slots: readonly SummarySlot[]): {
	toastmaster: NextMeetingRole | null;
	roles: NextMeetingRole[];
} {
	const groups = new Map<string, NextMeetingRole & { tm: boolean }>();
	for (const s of slots) {
		let g = groups.get(s.roleDefinitionId);
		if (!g) {
			g = { label: s.roleName, names: [], openCount: 0, tm: isToastmaster(s) };
			groups.set(s.roleDefinitionId, g);
		}
		const name = assigneeDisplayName(s.assigneeName, s.assigneeIsGuest);
		if (name) g.names.push(name);
		else g.openCount += 1;
	}
	let toastmaster: NextMeetingRole | null = null;
	const roles: NextMeetingRole[] = [];
	for (const { tm, ...role } of groups.values()) {
		if (tm && toastmaster == null) toastmaster = role;
		else roles.push(role);
	}
	return { toastmaster, roles };
}

/**
 * The absolute URL of the next meeting's public page, where a member claims a
 * role, for the slide's QR. Built from the BROWSER's origin like the ballot URL
 * (`ballotUrlFor`): SSR has none, and a QR encoding a relative path is not a
 * URL a phone's camera can open. Null until the origin is known, and null when
 * there is no next meeting — the slide then shows no QR at all.
 */
export function signupUrlFor(
	clubKey: string,
	next: { urlKey: string } | null,
	origin: string | null,
): string | null {
	if (!origin || !next) return null;
	return `${origin}/club/${encodeURIComponent(clubKey)}/meeting/${encodeURIComponent(next.urlKey)}`;
}

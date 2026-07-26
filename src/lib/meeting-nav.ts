import type { LinkProps } from "@tanstack/react-router";
import { formatShortDate } from "./format";
import { urlKeysForMeetings } from "./meeting-url";

export type MeetingNavItem = {
	meetingId: string;
	urlKey: string;
	label: string;
	isCurrent: boolean;
	hasOpenRoles: boolean;
};

type CurrentMeeting = {
	id: string;
	scheduledAt: Date | string;
	openSlots: number;
};
type UpcomingMeeting = {
	id: string;
	scheduledAt: Date | string;
	openSlots: number;
};

function toMillis(value: Date | string): number {
	return (typeof value === "string" ? new Date(value) : value).getTime();
}

/**
 * Build the sorted, labeled nav items for the member meeting strip.
 *
 * `listUpcomingMeetings` filters `scheduledAt >= now`, so a meeting being
 * viewed after it has started is absent from `upcoming`. We set `current` into
 * the map (deduped by id) so the strip always shows and highlights the viewed
 * meeting — and always with its own authoritative `openSlots` (derived from the
 * loaded agenda), which both covers the absent-from-`upcoming` case and keeps
 * the current tab's dot consistent with the roles shown on the page.
 *
 * `past` (#375) is the window of meetings immediately BEFORE the viewed one, so
 * the strip pages backwards instead of dead-ending at wherever you entered.
 * Past items never carry the open-roles dot: an unfilled role on a meeting that
 * already happened is history, not a call to action. `current` is written last,
 * so a current meeting that is itself past keeps its own authoritative dot.
 */
export function buildMeetingNavItems(
	current: CurrentMeeting,
	upcoming: UpcomingMeeting[],
	timezone: string,
	past: UpcomingMeeting[] = [],
): MeetingNavItem[] {
	const byId = new Map<string, UpcomingMeeting & { isPast: boolean }>();
	for (const m of past) byId.set(m.id, { ...m, isPast: true });
	for (const m of upcoming) byId.set(m.id, { ...m, isPast: false });
	byId.set(current.id, {
		id: current.id,
		scheduledAt: current.scheduledAt,
		openSlots: current.openSlots,
		isPast: false,
	});

	const ordered = [...byId.values()].sort(
		(a, b) => toMillis(a.scheduledAt) - toMillis(b.scheduledAt),
	);
	const keys = urlKeysForMeetings(ordered, timezone);
	return ordered.map((m) => ({
		meetingId: m.id,
		urlKey: keys.get(m.id) ?? m.id,
		label: formatShortDate(m.scheduledAt, timezone),
		isCurrent: m.id === current.id,
		hasOpenRoles: !m.isPast && m.openSlots > 0,
	}));
}

/**
 * Derive the meeting nav-strip items for a loaded meeting page. Centralizes the
 * "the current meeting's own open-role count (from its loaded agenda) overrides
 * whatever its row in `upcoming` says" rule so both the public and signed-in
 * meeting loaders share one implementation.
 */
export function deriveMeetingNavItems(
	meeting: { id: string; scheduledAt: Date | string },
	slots: { status: string }[],
	upcoming: UpcomingMeeting[],
	timezone: string,
	past: UpcomingMeeting[] = [],
): MeetingNavItem[] {
	const openSlots = slots.filter((s) => s.status === "open").length;
	return buildMeetingNavItems(
		{ id: meeting.id, scheduledAt: meeting.scheduledAt, openSlots },
		upcoming,
		timezone,
		past,
	);
}

/**
 * Default destination for a nav-strip item: the canonical club meeting page,
 * keyed by the item's club-local-date `urlKey`. Every audience (public + the
 * unified signed-in view) uses this now, so nav-strip paging stays on the pretty
 * meeting URL. A caller may still pass its own builder via `getLinkProps`.
 */
export function defaultMeetingNavLinkProps(
	clubId: string,
	item: MeetingNavItem,
): LinkProps {
	return {
		to: "/club/$clubId/meeting/$meetingId",
		params: { clubId, meetingId: item.urlKey },
	};
}

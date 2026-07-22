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
 */
export function buildMeetingNavItems(
	current: CurrentMeeting,
	upcoming: UpcomingMeeting[],
	timezone: string,
): MeetingNavItem[] {
	const byId = new Map<string, UpcomingMeeting>();
	for (const m of upcoming) byId.set(m.id, m);
	byId.set(current.id, {
		id: current.id,
		scheduledAt: current.scheduledAt,
		openSlots: current.openSlots,
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
		hasOpenRoles: m.openSlots > 0,
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
): MeetingNavItem[] {
	const openSlots = slots.filter((s) => s.status === "open").length;
	return buildMeetingNavItems(
		{ id: meeting.id, scheduledAt: meeting.scheduledAt, openSlots },
		upcoming,
		timezone,
	);
}

/**
 * Default destination for a nav-strip item: the public club meeting page, keyed
 * by the item's club-local-date `urlKey`. Signed-in views pass their own builder
 * (targeting `/meetings/$id` by raw id) so paging stays in the workspace.
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

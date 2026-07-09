import type { LinkProps } from "@tanstack/react-router";
import { formatShortDate } from "./format";

export type MeetingNavItem = {
	meetingId: string;
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

	return [...byId.values()]
		.sort((a, b) => toMillis(a.scheduledAt) - toMillis(b.scheduledAt))
		.map((m) => ({
			meetingId: m.id,
			label: formatShortDate(m.scheduledAt, timezone),
			isCurrent: m.id === current.id,
			hasOpenRoles: m.openSlots > 0,
		}));
}

/**
 * Default destination for a nav-strip item: the public club meeting page.
 * Signed-in views pass their own builder (targeting `/meetings/$id`) so paging
 * stays inside the workspace instead of jumping to the public tree (#140/#142).
 */
export function defaultMeetingNavLinkProps(
	clubId: string,
	meetingId: string,
): LinkProps {
	return {
		to: "/club/$clubId/meeting/$meetingId",
		params: { clubId, meetingId },
	};
}

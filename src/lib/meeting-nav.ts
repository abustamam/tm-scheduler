import { formatShortDate } from "./format";

export type MeetingNavItem = {
	meetingId: string;
	label: string;
	isCurrent: boolean;
	hasOpenRoles: boolean;
};

type CurrentMeeting = { id: string; scheduledAt: Date | string };
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
 * viewed after it has started is absent from `upcoming`. We union `current` in
 * (deduped by id) so the strip always shows and highlights the viewed meeting.
 */
export function buildMeetingNavItems(
	current: CurrentMeeting,
	upcoming: UpcomingMeeting[],
	timezone: string,
): MeetingNavItem[] {
	const byId = new Map<string, UpcomingMeeting>();
	for (const m of upcoming) byId.set(m.id, m);
	if (!byId.has(current.id)) {
		byId.set(current.id, {
			id: current.id,
			scheduledAt: current.scheduledAt,
			openSlots: 0,
		});
	}

	return [...byId.values()]
		.sort((a, b) => toMillis(a.scheduledAt) - toMillis(b.scheduledAt))
		.map((m) => ({
			meetingId: m.id,
			label: formatShortDate(m.scheduledAt, timezone),
			isCurrent: m.id === current.id,
			hasOpenRoles: m.openSlots > 0,
		}));
}

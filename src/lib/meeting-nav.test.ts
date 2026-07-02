import { describe, expect, it } from "vitest";
import { buildMeetingNavItems } from "./meeting-nav";

const TZ = "UTC";

describe("buildMeetingNavItems", () => {
	it("sorts by date, flags the current meeting, and maps open-role dots", () => {
		const items = buildMeetingNavItems(
			{ id: "b", scheduledAt: "2026-07-23T19:00:00Z", openSlots: 0 },
			[
				{ id: "b", scheduledAt: "2026-07-23T19:00:00Z", openSlots: 0 },
				{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 3 },
				{ id: "c", scheduledAt: "2026-08-13T19:00:00Z", openSlots: 1 },
			],
			TZ,
		);

		expect(items.map((i) => i.meetingId)).toEqual(["a", "b", "c"]);
		expect(items.map((i) => i.isCurrent)).toEqual([false, true, false]);
		expect(items.map((i) => i.hasOpenRoles)).toEqual([true, false, true]);
		expect(items.map((i) => i.label)).toEqual(["Jul 9", "Jul 23", "Aug 13"]);
	});

	it("shows the current meeting's dot from its own open count when it is a past meeting absent from upcoming", () => {
		// The current meeting already started, so listUpcomingMeetings excluded it,
		// but its loaded agenda still has open roles — the dot must reflect that.
		const items = buildMeetingNavItems(
			{ id: "past", scheduledAt: "2026-07-01T19:00:00Z", openSlots: 2 },
			[
				{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 2 },
				{ id: "c", scheduledAt: "2026-08-13T19:00:00Z", openSlots: 0 },
			],
			TZ,
		);

		expect(items.map((i) => i.meetingId)).toEqual(["past", "a", "c"]);
		const current = items.find((i) => i.isCurrent);
		expect(current?.meetingId).toBe("past");
		expect(current?.hasOpenRoles).toBe(true);
	});

	it("uses the current meeting's authoritative open count, overriding the upcoming-list row", () => {
		// The current meeting is in the upcoming set with a stale openSlots=2, but
		// its freshly-loaded agenda has 0 open roles — the current item wins.
		const items = buildMeetingNavItems(
			{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 0 },
			[{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 2 }],
			TZ,
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			meetingId: "a",
			isCurrent: true,
			hasOpenRoles: false,
		});
	});

	it("returns just the current meeting when upcoming is empty", () => {
		const items = buildMeetingNavItems(
			{ id: "only", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 0 },
			[],
			TZ,
		);
		expect(items).toEqual([
			{
				meetingId: "only",
				label: "Jul 9",
				isCurrent: true,
				hasOpenRoles: false,
			},
		]);
	});
});

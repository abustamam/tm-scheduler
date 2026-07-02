import { describe, expect, it } from "vitest";
import { buildMeetingNavItems } from "./meeting-nav";

const TZ = "UTC";

describe("buildMeetingNavItems", () => {
	it("sorts by date, flags the current meeting, and maps open-role dots", () => {
		const items = buildMeetingNavItems(
			{ id: "b", scheduledAt: "2026-07-23T19:00:00Z" },
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

	it("unions the current meeting in when it is not in the upcoming set (past meeting)", () => {
		// The current meeting already happened, so listUpcomingMeetings excluded it.
		const items = buildMeetingNavItems(
			{ id: "past", scheduledAt: "2026-07-01T19:00:00Z" },
			[
				{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 2 },
				{ id: "c", scheduledAt: "2026-08-13T19:00:00Z", openSlots: 0 },
			],
			TZ,
		);

		expect(items.map((i) => i.meetingId)).toEqual(["past", "a", "c"]);
		const current = items.find((i) => i.isCurrent);
		expect(current?.meetingId).toBe("past");
		expect(current?.hasOpenRoles).toBe(false); // no openSlots data for a unioned past meeting
	});

	it("does not duplicate the current meeting when it is already in the upcoming set", () => {
		const items = buildMeetingNavItems(
			{ id: "a", scheduledAt: "2026-07-09T19:00:00Z" },
			[{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 1 }],
			TZ,
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			meetingId: "a",
			isCurrent: true,
			hasOpenRoles: true,
		});
	});

	it("returns just the current meeting when upcoming is empty", () => {
		const items = buildMeetingNavItems(
			{ id: "only", scheduledAt: "2026-07-09T19:00:00Z" },
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

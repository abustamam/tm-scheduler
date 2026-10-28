import { describe, expect, it } from "vitest";
import {
	buildMeetingNavItems,
	defaultMeetingNavLinkProps,
	deriveMeetingNavItems,
} from "./meeting-nav";

const TZ = "UTC";

describe("buildMeetingNavItems", () => {
	it("uses the server's canonical key over one derived from the strip's own rows (#1396)", () => {
		// A cancelled meeting shares the date but is not in the strip, so the
		// strip alone would say the bare date.
		const items = buildMeetingNavItems(
			{
				id: "a",
				scheduledAt: "2026-07-09T19:00:00Z",
				openSlots: 0,
				urlKey: "2026-07-09-1900",
			},
			[
				{
					id: "b",
					scheduledAt: "2026-07-23T19:00:00Z",
					openSlots: 0,
					urlKey: "2026-07-23-1900",
				},
			],
			TZ,
		);
		expect(items.map((i) => i.urlKey)).toEqual([
			"2026-07-09-1900",
			"2026-07-23-1900",
		]);
	});

	it("sorts by date, flags the current meeting, and maps open-role dots", () => {
		const items = buildMeetingNavItems(
			{
				id: "b",
				scheduledAt: "2026-07-23T19:00:00Z",
				openSlots: 0,
				urlKey: "2026-07-23",
			},
			[
				{
					id: "b",
					scheduledAt: "2026-07-23T19:00:00Z",
					openSlots: 0,
					urlKey: "2026-07-23",
				},
				{
					id: "a",
					scheduledAt: "2026-07-09T19:00:00Z",
					openSlots: 3,
					urlKey: "2026-07-09",
				},
				{
					id: "c",
					scheduledAt: "2026-08-13T19:00:00Z",
					openSlots: 1,
					urlKey: "2026-08-13",
				},
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
			{
				id: "past",
				scheduledAt: "2026-07-01T19:00:00Z",
				openSlots: 2,
				urlKey: "2026-07-01",
			},
			[
				{
					id: "a",
					scheduledAt: "2026-07-09T19:00:00Z",
					openSlots: 2,
					urlKey: "2026-07-09",
				},
				{
					id: "c",
					scheduledAt: "2026-08-13T19:00:00Z",
					openSlots: 0,
					urlKey: "2026-08-13",
				},
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
			{
				id: "a",
				scheduledAt: "2026-07-09T19:00:00Z",
				openSlots: 0,
				urlKey: "2026-07-09",
			},
			[
				{
					id: "a",
					scheduledAt: "2026-07-09T19:00:00Z",
					openSlots: 2,
					urlKey: "2026-07-09",
				},
			],
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
			{
				id: "only",
				scheduledAt: "2026-07-09T19:00:00Z",
				openSlots: 0,
				urlKey: "2026-07-09",
			},
			[],
			TZ,
		);
		expect(items).toEqual([
			{
				meetingId: "only",
				urlKey: "2026-07-09",
				label: "Jul 9",
				isCurrent: true,
				hasOpenRoles: false,
			},
		]);
	});

	it("pages backwards: past meetings sort ahead of the current one and stay linkable", () => {
		const items = buildMeetingNavItems(
			{
				id: "cur",
				scheduledAt: "2026-07-23T19:00:00Z",
				openSlots: 0,
				urlKey: "2026-07-23",
			},
			[
				{
					id: "next",
					scheduledAt: "2026-07-30T19:00:00Z",
					openSlots: 1,
					urlKey: "2026-07-30",
				},
			],
			TZ,
			[
				{
					id: "older",
					scheduledAt: "2026-07-02T19:00:00Z",
					openSlots: 0,
					urlKey: "2026-07-02",
				},
				{
					id: "prev",
					scheduledAt: "2026-07-09T19:00:00Z",
					openSlots: 0,
					urlKey: "2026-07-09",
				},
			],
		);

		expect(items.map((i) => i.meetingId)).toEqual([
			"older",
			"prev",
			"cur",
			"next",
		]);
		expect(items.map((i) => i.isCurrent)).toEqual([false, false, true, false]);
		expect(items.map((i) => i.urlKey)).toEqual([
			"2026-07-02",
			"2026-07-09",
			"2026-07-23",
			"2026-07-30",
		]);
	});

	it("never shows an open-roles dot on a past meeting", () => {
		// A meeting that has already happened with unfilled roles is history, not a
		// call to action — the dot would read as "go claim this".
		const items = buildMeetingNavItems(
			{
				id: "cur",
				scheduledAt: "2026-07-23T19:00:00Z",
				openSlots: 0,
				urlKey: "2026-07-23",
			},
			[
				{
					id: "next",
					scheduledAt: "2026-07-30T19:00:00Z",
					openSlots: 2,
					urlKey: "2026-07-30",
				},
			],
			TZ,
			[
				{
					id: "prev",
					scheduledAt: "2026-07-09T19:00:00Z",
					openSlots: 4,
					urlKey: "2026-07-09",
				},
			],
		);

		expect(items.find((i) => i.meetingId === "prev")?.hasOpenRoles).toBe(false);
		expect(items.find((i) => i.meetingId === "next")?.hasOpenRoles).toBe(true);
	});

	it("keeps the current meeting's own dot when it also appears in the past window", () => {
		// Viewing a past meeting: its authoritative agenda still wins over the
		// past-window row, so the current tab's dot matches the roles on the page.
		const items = buildMeetingNavItems(
			{
				id: "cur",
				scheduledAt: "2026-07-09T19:00:00Z",
				openSlots: 3,
				urlKey: "2026-07-09",
			},
			[],
			TZ,
			[
				{
					id: "cur",
					scheduledAt: "2026-07-09T19:00:00Z",
					openSlots: 0,
					urlKey: "2026-07-09",
				},
				{
					id: "older",
					scheduledAt: "2026-07-02T19:00:00Z",
					openSlots: 1,
					urlKey: "2026-07-02",
				},
			],
		);

		expect(items.map((i) => i.meetingId)).toEqual(["older", "cur"]);
		const current = items.find((i) => i.isCurrent);
		expect(current?.meetingId).toBe("cur");
		expect(current?.hasOpenRoles).toBe(true);
		expect(items.find((i) => i.meetingId === "older")?.hasOpenRoles).toBe(
			false,
		);
	});

	it("emits a club-local-date urlKey per item and keeps meetingId as the raw id", () => {
		const items = buildMeetingNavItems(
			{
				id: "cur",
				scheduledAt: new Date("2026-07-21T23:45:00Z"),
				openSlots: 0,
				urlKey: "2026-07-21",
			},
			[
				{
					id: "up",
					scheduledAt: new Date("2026-07-28T23:45:00Z"),
					openSlots: 2,
					urlKey: "2026-07-28",
				},
			],
			"America/Chicago",
		);
		const cur = items.find((i) => i.meetingId === "cur");
		const up = items.find((i) => i.meetingId === "up");
		expect(cur?.urlKey).toBe("2026-07-21");
		expect(up?.urlKey).toBe("2026-07-28");
	});
});

describe("deriveMeetingNavItems", () => {
	it("derives the current meeting's open-role dot from its slots, overriding its upcoming row", () => {
		const items = deriveMeetingNavItems(
			{ id: "a", scheduledAt: "2026-07-09T19:00:00Z" },
			"2026-07-09",
			[{ status: "open" }, { status: "confirmed" }, { status: "claimed" }],
			// Upcoming lists the current meeting with a stale openSlots=0.
			[
				{
					id: "a",
					scheduledAt: "2026-07-09T19:00:00Z",
					openSlots: 0,
					urlKey: "2026-07-09",
				},
			],
			TZ,
		);

		const current = items.find((i) => i.isCurrent);
		expect(current?.meetingId).toBe("a");
		// Derived from the one "open" slot, not the upcoming-list's 0.
		expect(current?.hasOpenRoles).toBe(true);
	});

	it("threads the past window through so the strip pages backwards", () => {
		const items = deriveMeetingNavItems(
			{ id: "b", scheduledAt: "2026-07-16T19:00:00Z" },
			"2026-07-16",
			[{ status: "open" }],
			[
				{
					id: "c",
					scheduledAt: "2026-07-23T19:00:00Z",
					openSlots: 0,
					urlKey: "2026-07-23",
				},
			],
			TZ,
			[
				{
					id: "a",
					scheduledAt: "2026-07-09T19:00:00Z",
					openSlots: 2,
					urlKey: "2026-07-09",
				},
			],
		);

		expect(items.map((i) => i.meetingId)).toEqual(["a", "b", "c"]);
		expect(items.find((i) => i.meetingId === "a")?.hasOpenRoles).toBe(false);
	});

	it("is unchanged when no past window is supplied", () => {
		const items = deriveMeetingNavItems(
			{ id: "a", scheduledAt: "2026-07-09T19:00:00Z" },
			"2026-07-09",
			[],
			[
				{
					id: "b",
					scheduledAt: "2026-07-16T19:00:00Z",
					openSlots: 1,
					urlKey: "2026-07-16",
				},
			],
			TZ,
		);
		expect(items.map((i) => i.meetingId)).toEqual(["a", "b"]);
	});
});

describe("defaultMeetingNavLinkProps", () => {
	it("targets the public club meeting route keyed by the item's urlKey", () => {
		expect(
			defaultMeetingNavLinkProps("koala-tm", {
				meetingId: "m-123",
				urlKey: "2026-07-09",
				label: "Jul 9",
				isCurrent: true,
				hasOpenRoles: false,
			}),
		).toEqual({
			to: "/club/$clubId/meeting/$meetingId",
			params: { clubId: "koala-tm", meetingId: "2026-07-09" },
		});
	});
});

describe("the strip with the past-but-after gap (#1158)", () => {
	// A completed, B past-but-unfinished, C upcoming. The route feeds the
	// `before = viewed` window and the `after = viewed` gap in as `past`, so the
	// two overlap on the viewed meeting and on nothing else.
	const A = {
		id: "A",
		scheduledAt: "2026-09-24T23:00:00Z",
		openSlots: 0,
		urlKey: "2026-09-24",
	};
	const B = {
		id: "B",
		scheduledAt: "2026-10-08T23:00:00Z",
		openSlots: 3,
		urlKey: "2026-10-08",
	};
	const C = {
		id: "C",
		scheduledAt: "2026-10-22T23:00:00Z",
		openSlots: 2,
		urlKey: "2026-10-22",
	};

	it("shows A, B and C in order from A, B and C, each exactly once", () => {
		const cases = [
			{ viewed: A, before: [], gap: [A, B] },
			{ viewed: B, before: [A], gap: [B] },
			{ viewed: C, before: [A, B], gap: [] },
		];
		for (const { viewed, before, gap } of cases) {
			const items = deriveMeetingNavItems(viewed, viewed.urlKey, [], [C], TZ, [
				...before,
				...gap,
			]);
			expect(items.map((i) => i.meetingId)).toEqual(["A", "B", "C"]);
			expect(items.filter((i) => i.isCurrent).map((i) => i.meetingId)).toEqual([
				viewed.id,
			]);
		}
	});

	it("gives the unfinished past meeting no open-roles dot", () => {
		const items = deriveMeetingNavItems(A, A.urlKey, [], [C], TZ, [A, B]);
		expect(items.find((i) => i.meetingId === "B")?.hasOpenRoles).toBe(false);
		expect(items.find((i) => i.meetingId === "C")?.hasOpenRoles).toBe(true);
	});
});

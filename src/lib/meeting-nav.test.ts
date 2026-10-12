import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildMeetingNavItems,
	collectMeetingsAfter,
	defaultMeetingNavLinkProps,
	deriveMeetingNavItems,
} from "./meeting-nav";

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
				urlKey: "2026-07-09",
				label: "Jul 9",
				isCurrent: true,
				hasOpenRoles: false,
			},
		]);
	});

	it("pages backwards: past meetings sort ahead of the current one and stay linkable", () => {
		const items = buildMeetingNavItems(
			{ id: "cur", scheduledAt: "2026-07-23T19:00:00Z", openSlots: 0 },
			[{ id: "next", scheduledAt: "2026-07-30T19:00:00Z", openSlots: 1 }],
			TZ,
			[
				{ id: "older", scheduledAt: "2026-07-02T19:00:00Z", openSlots: 0 },
				{ id: "prev", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 0 },
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
			{ id: "cur", scheduledAt: "2026-07-23T19:00:00Z", openSlots: 0 },
			[{ id: "next", scheduledAt: "2026-07-30T19:00:00Z", openSlots: 2 }],
			TZ,
			[{ id: "prev", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 4 }],
		);

		expect(items.find((i) => i.meetingId === "prev")?.hasOpenRoles).toBe(false);
		expect(items.find((i) => i.meetingId === "next")?.hasOpenRoles).toBe(true);
	});

	it("keeps the current meeting's own dot when it also appears in the past window", () => {
		// Viewing a past meeting: its authoritative agenda still wins over the
		// past-window row, so the current tab's dot matches the roles on the page.
		const items = buildMeetingNavItems(
			{ id: "cur", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 3 },
			[],
			TZ,
			[
				{ id: "cur", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 0 },
				{ id: "older", scheduledAt: "2026-07-02T19:00:00Z", openSlots: 1 },
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
			},
			[
				{
					id: "up",
					scheduledAt: new Date("2026-07-28T23:45:00Z"),
					openSlots: 2,
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
			[{ status: "open" }, { status: "confirmed" }, { status: "claimed" }],
			// Upcoming lists the current meeting with a stale openSlots=0.
			[{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 0 }],
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
			[{ status: "open" }],
			[{ id: "c", scheduledAt: "2026-07-23T19:00:00Z", openSlots: 0 }],
			TZ,
			[{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 2 }],
		);

		expect(items.map((i) => i.meetingId)).toEqual(["a", "b", "c"]);
		expect(items.find((i) => i.meetingId === "a")?.hasOpenRoles).toBe(false);
	});

	it("is unchanged when no past window is supplied", () => {
		const items = deriveMeetingNavItems(
			{ id: "a", scheduledAt: "2026-07-09T19:00:00Z" },
			[],
			[{ id: "b", scheduledAt: "2026-07-16T19:00:00Z", openSlots: 1 }],
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

describe("collectMeetingsAfter (#1158)", () => {
	const NOW = new Date("2026-10-12T12:00:00Z");

	/** An archive page source over `rows`, newest first, like `listPastMeetings`. */
	function archive(rows: { id: string; scheduledAt: string }[], size: number) {
		const desc = [...rows].sort((a, b) =>
			b.scheduledAt.localeCompare(a.scheduledAt),
		);
		const calls: number[] = [];
		const fetchPage = async (offset: number) => {
			calls.push(offset);
			const slice = desc.slice(offset, offset + size);
			return { meetings: slice, hasMore: offset + size < desc.length };
		};
		return { fetchPage, calls };
	}

	const A = { id: "A", scheduledAt: "2026-09-24T23:00:00Z" };
	const B = { id: "B", scheduledAt: "2026-10-08T23:00:00Z" };
	const C = { id: "C", scheduledAt: "2026-10-22T23:00:00Z" };

	it("fills the gap so a strip viewed from the completed meeting reaches the unfinished one and the upcoming one", async () => {
		// A completed, B past-but-unfinished, C upcoming. Past archive holds A and B.
		const { fetchPage } = archive([A, B], 100);
		const gap = await collectMeetingsAfter(A.scheduledAt, NOW, fetchPage, 100);

		const items = deriveMeetingNavItems(
			{ id: "A", scheduledAt: A.scheduledAt },
			[],
			[{ ...C, openSlots: 2 }],
			TZ,
			gap.map((m) => ({ ...m, openSlots: 0 })),
		);
		expect(items.map((i) => i.meetingId)).toEqual(["A", "B", "C"]);
	});

	it("shows all three from B and from C as well, without duplicates", async () => {
		const { fetchPage } = archive([A, B], 100);
		for (const [viewed, before] of [
			[B, [A]],
			[C, [A, B]],
		] as const) {
			const gap = await collectMeetingsAfter(
				viewed.scheduledAt,
				NOW,
				fetchPage,
				100,
			);
			const items = deriveMeetingNavItems(
				{ id: viewed.id, scheduledAt: viewed.scheduledAt },
				[],
				[{ ...C, openSlots: 0 }],
				TZ,
				// The backward window plus the gap, overlapping on purpose.
				[...before, ...gap, ...before].map((m) => ({ ...m, openSlots: 0 })),
			);
			expect(items.map((i) => i.meetingId)).toEqual(["A", "B", "C"]);
		}
	});

	it("fetches nothing when the viewed meeting is not in the past", async () => {
		const { fetchPage, calls } = archive([A, B], 100);
		const gap = await collectMeetingsAfter(C.scheduledAt, NOW, fetchPage, 100);
		expect(gap).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("keeps paging until it reaches the viewed meeting, since the archive is newest first", async () => {
		const rows = Array.from({ length: 5 }, (_, i) => ({
			id: `m${i}`,
			scheduledAt: `2026-0${i + 1}-07T19:00:00Z`,
		}));
		const { fetchPage, calls } = archive(rows, 2);
		const gap = await collectMeetingsAfter(
			rows[1]?.scheduledAt ?? "",
			NOW,
			fetchPage,
			2,
		);
		// m4, m3, m2 and the viewed m1 itself (the strip dedupes it).
		expect(gap.map((m) => m.id)).toEqual(["m4", "m3", "m2", "m1"]);
		expect(calls).toEqual([0, 2]);
	});

	it("stops paging when the archive runs out", async () => {
		const { fetchPage, calls } = archive([A, B], 1);
		const gap = await collectMeetingsAfter(
			"2020-01-01T00:00:00Z",
			NOW,
			fetchPage,
			1,
		);
		expect(gap.map((m) => m.id)).toEqual(["B", "A"]);
		expect(calls).toEqual([0, 1]);
	});
});

describe("meeting page loader wiring (#1158)", () => {
	it("feeds the gap into the strip's past window", () => {
		const src = readFileSync(
			resolve(__dirname, "../routes/club.$clubId.meeting.$meetingId.tsx"),
			"utf8",
		);
		expect(src).toMatch(/collectMeetingsAfter\(/);
		expect(src).toMatch(/\[\.\.\.\(past\?\.meetings \?\? \[\]\), \.\.\.gap\]/);
	});
});

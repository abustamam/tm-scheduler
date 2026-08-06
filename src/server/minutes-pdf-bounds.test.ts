// A BEHAVIOURAL bound on the minutes PDF (#522), not a source grep.
//
// `speaker-caps.guard.test.ts` pins that the caps are written in the source.
// That is a real defence against deleting them, but it cannot prove the render
// is actually bounded — a `cap()` call with the wrong argument, or a new
// uncapped section, satisfies a regex just as well.
//
// The first version of #522 asserted this was untestable ("`renderMinutesPdf`
// needs a database and a published meeting, so the one line that lays out the
// program list is not reachable from a unit test at all"). That was wrong, and
// the counter-example was 40 lines away: `role-sheets-pdf-logic.test.ts` mocks
// `#/db` plus the logic module and renders the REAL public entry point,
// asserting an ABSOLUTE page count. `renderMinutesPdf` has the identical
// dependency shape — two `db.select()…limit()` chains plus `loadMinutes` and
// `loadMinutesProgram` — so the same harness works here.
//
// The mocks answer by SHAPE, not by call order, so rearranging the two reads
// keeps the fixture honest.
import { describe, expect, it, vi } from "vitest";
import { MINUTES_RENDER_CAPS } from "#/lib/minutes-render-caps";

const stored: {
	meeting: Record<string, unknown>;
	club: Record<string, unknown>;
} = {
	meeting: {},
	club: {},
};

vi.mock("#/db", () => {
	const chain = (cols: Record<string, unknown>) => {
		const self = {
			from: () => self,
			where: () => self,
			limit: () =>
				Promise.resolve(["name" in cols ? stored.club : stored.meeting]),
		};
		return self;
	};
	return { db: { select: chain } };
});

const minutes: { data: unknown; program: unknown[] } = {
	data: null,
	program: [],
};

vi.mock("./minutes-logic", () => ({
	loadMinutes: () => Promise.resolve(minutes.data),
	loadMinutesProgram: () => Promise.resolve(minutes.program),
}));

import { renderMinutesPdf } from "./minutes-pdf-logic";

/**
 * How long the all-axes-hostile render may take, as an explicit per-test
 * timeout rather than an assertion in the body.
 *
 * This is a deliberate stress test and it is genuinely slow: laying out 60
 * program rows plus 40 Table Topics rows of capped EMOJI is inherent work, not
 * a leak. Measured ~3.6s alone, ~8.7s under full-suite contention locally, and
 * past 15s on CI's runner — which is how the first version failed, silently
 * hitting vitest's 15,000ms default before the body's own 30s check could run.
 *
 * The timeout doubles as the bound. If a cap is lost, the render goes to tens
 * of seconds (2,000 uncapped rows measured 2,477ms; 5,000 measured 19,581ms,
 * and emoji multiply that ~13x), so it blows through this and the test fails.
 * The deterministic page-count assertion is the sharper check; this catches the
 * pathological case that somehow keeps the page count down.
 */
const HOSTILE_TIMEOUT_MS = 60_000;

/** Read the page count out of the PDF's own page tree. */
function pageCount(bytes: Uint8Array): number {
	const m = Buffer.from(bytes)
		.toString("latin1")
		.match(/\/Count\s+(\d+)/);
	if (m == null) throw new Error("no /Count in the PDF page tree");
	return Number(m[1]);
}

describe("renderMinutesPdf bounds what it lays out (#522)", () => {
	/**
	 * Every unbounded user field AT ONCE, which is the case no single-variable
	 * fixture catches (CLAUDE.md trap 4). Hostile on BOTH axes the change
	 * bounds: per-string length and row COUNT.
	 *
	 * Astral rather than ASCII on the string axis on purpose. The cap bypass
	 * this PR fixes was invisible to every ASCII fixture in the repo, because an
	 * ASCII prefix forces the truncating branch and never reaches the buggy one.
	 */
	function hostile() {
		const long = "😀".repeat(60_000);
		stored.meeting = {
			clubId: "club-1",
			scheduledAt: new Date("2026-08-04T01:00:00Z"),
			theme: long,
			wordOfTheDay: long,
		};
		stored.club = { name: long, timezone: "America/Chicago" };
		minutes.data = {
			members: Array.from({ length: 400 }, (_, i) => ({
				name: `${long.slice(0, 200)} ${i}`,
				status: "present" as const,
			})),
			guests: [{ name: long }],
			counts: { present: 400, absent: 0, excused: 0, unmarked: 0, guests: 1 },
			// Action items (#529) are the newest unbounded list to reach this
			// renderer, so they belong in the all-axes-hostile fixture rather than
			// beside it — a merge that adds a list and tests it separately leaves
			// the cross-product tested by neither (CLAUDE.md trap 4).
			actionItems: {
				open: Array.from({ length: 2_000 }, (_, i) => ({
					id: `ai-${i}`,
					text: long,
					ownerName: long,
					ownerMemberId: null,
					dueDate: null,
					createdAt: new Date("2026-01-01T00:00:00Z"),
					resolvedAt: null,
					resolution: null,
				})),
				resolved: Array.from({ length: 2_000 }, (_, i) => ({
					id: `air-${i}`,
					text: long,
					ownerName: long,
					ownerMemberId: null,
					dueDate: null,
					createdAt: new Date("2026-01-01T00:00:00Z"),
					resolvedAt: new Date("2026-02-01T00:00:00Z"),
					resolution: "done" as const,
				})),
			},
			tableTopicsSpeakers: Array.from({ length: 2_000 }, (_, i) => ({
				id: `tt-${i}`,
				name: long,
				isGuest: false,
				topic: long,
			})),
			awards: [
				{ category: "best_speaker" as const, name: long, isGuest: false },
			],
		};
		minutes.program = Array.from({ length: 2_000 }, (_, i) => ({
			slotId: `slot-${i}`,
			roleName: long,
			category: "speaker",
			assigneeName: long,
			isGuest: false,
			speechTitle: long,
		}));
	}

	it(
		"renders a bounded document from hostile stored data, and quickly",
		async () => {
			hostile();

			const started = performance.now();
			const bytes = await renderMinutesPdf("meeting-1");
			const elapsed = performance.now() - started;

			// PAGE COUNT is the real assertion here, and it is deterministic. Every
			// way of losing a bound shows up in it: drop a row slice and 2,000
			// program rows arrive; drop a string cap and each row grows without
			// limit; break `cap()` and the whole 60,000-emoji value renders. All of
			// those are hundreds of pages. An ABSOLUTE ceiling, not one stated
			// relative to `MINUTES_RENDER_CAPS` — a ceiling written against the
			// constant passes for every value of it, including one that reintroduces
			// the stall.
			expect(pageCount(bytes)).toBeLessThanOrEqual(12);

			// The TIMEOUT on this test is the wall-clock bound, not an assertion in
			// the body — see the third argument below. An `expect(elapsed)` here is
			// unreachable when the render is the thing that regressed: vitest kills
			// the test at its own limit first and reports a timeout, which is exactly
			// what happened on CI when this file was written with a 30s assertion
			// under the default 15s limit.
			//
			// The elapsed figure is still worth recording, generously, because a
			// regression that is slow-but-not-timing-out should also be visible.
			expect(elapsed).toBeLessThan(HOSTILE_TIMEOUT_MS);
		},
		HOSTILE_TIMEOUT_MS,
	);

	it("still renders the ordinary case correctly", async () => {
		stored.meeting = {
			clubId: "club-1",
			scheduledAt: new Date("2026-08-04T01:00:00Z"),
			theme: "Courage",
			wordOfTheDay: "Ephemeral",
		};
		stored.club = { name: "Harbor City Speakers", timezone: "America/Chicago" };
		minutes.data = {
			members: [{ name: "Jane Doe", status: "present" as const }],
			guests: [],
			counts: { present: 1, absent: 0, excused: 0, unmarked: 0, guests: 0 },
			actionItems: {
				open: [
					{
						id: "ai-1",
						text: "Book the venue",
						ownerName: null,
						ownerMemberId: null,
						dueDate: null,
						createdAt: new Date("2026-01-01T00:00:00Z"),
						resolvedAt: null,
						resolution: null,
					},
				],
				resolved: [],
			},
			tableTopicsSpeakers: [
				{ id: "tt-1", name: "Ann Lee", isGuest: false, topic: "Travel" },
			],
			awards: [
				{ category: "best_speaker" as const, name: "Jane Doe", isGuest: false },
			],
		};
		minutes.program = [
			{
				slotId: "slot-1",
				roleName: "Speaker 1",
				category: "speaker",
				assigneeName: "Jane Doe",
				speechTitle: "The Ice Breaker",
				isGuest: false,
			},
		];

		const bytes = await renderMinutesPdf("meeting-1");
		expect(pageCount(bytes)).toBe(1);
		// Nothing was elided from a perfectly ordinary meeting.
		const text = Buffer.from(bytes).toString("latin1");
		expect(text).not.toContain("…");
	});

	/**
	 * The LOWER half of the caps, which the upper-bound assertions cannot see.
	 * `name: 5` or `nameRows: 0` bounds the render beautifully and silently
	 * elides data the write path accepts, and every DoS-direction test stays
	 * green. Sized against what the WRITE paths actually allow.
	 */
	it("leaves room for every value the write paths accept", () => {
		// `guestBookSchema` caps a guest name at 120; `members.ts` at 80.
		expect(MINUTES_RENDER_CAPS.name).toBeGreaterThanOrEqual(120);
		// `WOD_LIMITS.word` is 60.
		expect(MINUTES_RENDER_CAPS.word).toBeGreaterThanOrEqual(60);
		// A club name and a role label are short, but not 5 characters short.
		expect(MINUTES_RENDER_CAPS.club).toBeGreaterThanOrEqual(80);
		expect(MINUTES_RENDER_CAPS.roleName).toBeGreaterThanOrEqual(60);
		// A theme and a Table Topics topic are a phrase, not a word.
		expect(MINUTES_RENDER_CAPS.theme).toBeGreaterThanOrEqual(100);
		expect(MINUTES_RENDER_CAPS.topic).toBeGreaterThanOrEqual(100);
		// A roster line must fit a real club before it says "+N more".
		expect(MINUTES_RENDER_CAPS.nameRows).toBeGreaterThanOrEqual(60);
		expect(MINUTES_RENDER_CAPS.tableTopicsRows).toBeGreaterThanOrEqual(20);
	});
});

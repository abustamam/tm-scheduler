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

	it("renders a bounded document from hostile stored data, and quickly", async () => {
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

		// Wall clock is only a coarse backstop, because this suite runs 200+ files
		// in parallel and the number is load-dependent: this fixture measures
		// ~3.6s run alone and ~8.7s under full-suite contention. Asserting near
		// the isolated figure would flake on a busy CI box, so the threshold sits
		// well above it and catches only the gross case.
		//
		// The timing still earned its place. At the first-pass caps (200 program
		// rows, 100 Table Topics) this fixture took 8.9s ALONE with every string
		// cap correctly applied, because a length cap bounds code points and not
		// COST: emoji rows measured ~13x ASCII rows at the same capped size. That
		// is what drove the row caps down to 60/40.
		expect(elapsed).toBeLessThan(30_000);
	});

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

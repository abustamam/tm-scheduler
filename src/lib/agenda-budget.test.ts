import { describe, expect, it } from "vitest";
import {
	type BudgetEntry,
	foldRepeatTail,
	groupIntoBands,
	summarizeAgenda,
} from "./agenda-budget";

const TZ = "America/Chicago";
/** 6:45 PM America/Chicago, 2026-09-10 — MCF's club contest. */
const START = new Date("2026-09-10T23:45:00.000Z");

/** One entry, defaulted. `section: true` marks a band row. */
function entry(
	over: { minutes: number; who?: string; section?: true; time?: string },
	src: Partial<Omit<BudgetEntry, "row">> = {},
): BudgetEntry {
	return {
		row: {
			who: over.who ?? "x",
			detail: "",
			marks: null,
			minutes: over.minutes,
			time: over.time ?? "0:00",
			...(over.section ? { section: true as const } : {}),
		},
		beatId: src.beatId ?? "b",
		iteration: src.iteration ?? 0,
		iterationCount: src.iterationCount ?? 1,
	};
}

/** The seeded speech contest at four contestants, in EMISSION order. */
function contest(): BudgetEntry[] {
	const out: BudgetEntry[] = [
		entry({ who: "OPENING", minutes: 0, section: true }, { beatId: "s1" }),
		entry({ who: "Call to order", minutes: 5 }, { beatId: "o1" }),
		entry({ who: "Welcome and introductions", minutes: 5 }, { beatId: "o2" }),
		entry({ who: "Judges' briefing", minutes: 10 }, { beatId: "o3" }),
		entry({ who: "Contest rules and timing", minutes: 5 }, { beatId: "o4" }),
		entry({ who: "SPEECHES", minutes: 0, section: true }, { beatId: "s2" }),
	];
	// The interleave: one whole block per iteration, so the speech beat owns
	// positions 0, 2, 4, 6 of this run and never a contiguous stretch.
	for (let n = 0; n < 4; n += 1) {
		out.push(
			entry(
				{ who: `Contest speech ${n + 1}`, minutes: 7 },
				{ beatId: "sp", iteration: n, iterationCount: 4 },
			),
			entry(
				{ who: "One minute of silence", minutes: 1 },
				{ beatId: "si", iteration: n, iterationCount: 4 },
			),
		);
	}
	out.push(
		entry({ who: "Two minutes of silence", minutes: 2 }, { beatId: "t1" }),
		entry({ who: "Contestant interviews", minutes: 5 }, { beatId: "t2" }),
		entry(
			{ who: "RESULTS AND CLOSING", minutes: 0, section: true },
			{ beatId: "s3" },
		),
		entry({ who: "Tallying", minutes: 10 }, { beatId: "r1" }),
		entry({ who: "Timers' report", minutes: 3 }, { beatId: "r2" }),
		entry({ who: "Results and certificates", minutes: 10 }, { beatId: "r3" }),
		entry({ who: "Closing remarks", minutes: 5 }, { beatId: "r4" }),
	);
	return out;
}

describe("summarizeAgenda", () => {
	it("costs MCF's 2026-09-10 contest at 92 minutes against a 90-minute slot", () => {
		// ABSOLUTE literals, not values re-derived from the code under test. A
		// relative assertion (`total === sumOf(rows)`) passes for every possible
		// bug, which is the #519 trap.
		const b = summarizeAgenda(contest(), 90, START, TZ);
		expect(b.totalMinutes).toBe(92);
		expect(b.slotMinutes).toBe(90);
		expect(b.deltaMinutes).toBe(2);
		expect(b.endsAt).toBe("8:17");
	});

	it("subtotals each section band", () => {
		expect(summarizeAgenda(contest(), 90, START, TZ).sections).toEqual([
			{ label: "OPENING", minutes: 25 },
			{ label: "SPEECHES", minutes: 39 },
			{ label: "RESULTS AND CLOSING", minutes: 28 },
		]);
	});

	it("reports the delta EXACTLY inside the ±2 tolerance, never softened", () => {
		// The whole point of D5. `applyFlex` collapses |delta| <= 2 to "exact", so
		// a readout derived from `status` would say NOTHING about the very meeting
		// that motivated this feature.
		const b = summarizeAgenda(contest(), 90, START, TZ);
		expect(b.deltaMinutes).toBe(2);
		expect(b.deltaMinutes).not.toBe(0);
	});

	it("signs the delta negative when the agenda ends early", () => {
		const b = summarizeAgenda(contest(), 100, START, TZ);
		expect(b.deltaMinutes).toBe(-8);
		// The end time is a property of the AGENDA, not of the slot — widening the
		// booking must not move it.
		expect(b.endsAt).toBe("8:17");
	});

	it("reports zero delta when the agenda exactly fills its slot", () => {
		expect(summarizeAgenda(contest(), 92, START, TZ).deltaMinutes).toBe(0);
	});

	it("counts rows before the first section into no section", () => {
		const b = summarizeAgenda(
			[
				entry({ who: "Stray", minutes: 4 }),
				entry({ who: "OPENING", minutes: 0, section: true }),
				entry({ who: "Call to order", minutes: 5 }),
			],
			90,
			START,
			TZ,
		);
		// An agenda may legally open without a band. Inventing an "(untitled)"
		// section would put a heading on the printed page's behalf that nothing
		// stored asked for — but the minutes still count toward the total.
		expect(b.sections).toEqual([{ label: "OPENING", minutes: 5 }]);
		expect(b.totalMinutes).toBe(9);
	});

	it("handles an empty agenda without inventing a section or a time", () => {
		const b = summarizeAgenda([], 90, START, TZ);
		expect(b.totalMinutes).toBe(0);
		expect(b.sections).toEqual([]);
		expect(b.deltaMinutes).toBe(-90);
		expect(b.endsAt).toBe("6:45");
	});
});

describe("groupIntoBands", () => {
	it("bands a repeat block by iteration and marks only the first editable", () => {
		const iters = groupIntoBands(contest()).filter(
			(b) => b.kind === "iteration",
		);
		expect(iters).toHaveLength(4);
		expect(iters.map((b) => b.kind === "iteration" && b.editable)).toEqual([
			true,
			false,
			false,
			false,
		]);
		// speech 7 + silence 1, per contestant.
		expect(iters.map((b) => b.kind === "iteration" && b.minutes)).toEqual([
			8, 8, 8, 8,
		]);
	});

	it("keeps every non-repeating row a plain band, in order", () => {
		const bands = groupIntoBands(contest());
		expect(bands[0]).toEqual({ kind: "row", entry: contest()[0] });
		// 3 sections + 4 opening + 2 tail + 4 results = 13.
		expect(bands.filter((b) => b.kind === "row")).toHaveLength(13);
	});

	it("carries the clock span of each iteration band", () => {
		// The span is what lets iterations 2..N collapse without losing timing
		// information — a collapsed band still says when it starts and ends.
		const timed = contest().map((e, i) =>
			i === 6 ? { ...e, row: { ...e.row, time: "7:10" } } : e,
		);
		const first = groupIntoBands(timed).find((b) => b.kind === "iteration");
		expect(first?.kind === "iteration" && first.startsAt).toBe("7:10");
	});

	it("produces no iteration band at a single arity", () => {
		// One contestant: `numbered()` stops numbering and there is no 2..N to
		// collapse, so the row must render as an ordinary one.
		const one = [
			entry(
				{ who: "Contest speech", minutes: 7 },
				{ beatId: "sp", iteration: 0, iterationCount: 1 },
			),
		];
		expect(groupIntoBands(one)).toEqual([{ kind: "row", entry: one[0] }]);
	});

	it("produces nothing at all for an empty block", () => {
		expect(groupIntoBands([])).toEqual([]);
	});

	it("folds iterations 2..N into one summary band, carrying the span", () => {
		const timed = contest().map((e, i) => {
			// Stamp the speech block with its real clock so the span is meaningful.
			const times = [
				"7:10",
				"7:17",
				"7:18",
				"7:25",
				"7:26",
				"7:33",
				"7:34",
				"7:41",
			];
			return i >= 6 && i <= 13
				? { ...e, row: { ...e.row, time: times[i - 6] as string } }
				: e;
		});
		const folded = foldRepeatTail(groupIntoBands(timed));
		const tail = folded.find((b) => b.kind === "repeatTail");
		if (tail?.kind !== "repeatTail") throw new Error("no folded tail");
		// Contestants 2 through 4, starting 7:18 and ending 7:41, 24 minutes.
		expect(tail.fromIteration).toBe(2);
		expect(tail.toIteration).toBe(4);
		expect(tail.startsAt).toBe("7:18");
		expect(tail.lastRowStartsAt).toBe("7:41");
		expect(tail.minutes).toBe(24);
		// Exactly ONE editable iteration survives, and it is the first.
		const editable = folded.filter((b) => b.kind === "iteration");
		expect(editable).toHaveLength(1);
	});

	it("folds nothing when a block has a single iteration", () => {
		const one = [
			entry(
				{ who: "Contest speech", minutes: 7 },
				{ beatId: "sp", iteration: 0, iterationCount: 1 },
			),
		];
		expect(foldRepeatTail(groupIntoBands(one))).toEqual([
			{ kind: "row", entry: one[0] },
		]);
	});

	it("does not fold two DIFFERENT blocks' tails together", () => {
		// Two blocks, each with a non-editable second iteration. Folding on
		// "not editable" alone would merge them into one summary spanning both.
		const rows = [
			entry({ minutes: 7 }, { beatId: "a", iteration: 0, iterationCount: 2 }),
			entry({ minutes: 7 }, { beatId: "a", iteration: 1, iterationCount: 2 }),
			entry({ minutes: 3 }, { beatId: "b", iteration: 0, iterationCount: 5 }),
			entry({ minutes: 3 }, { beatId: "b", iteration: 1, iterationCount: 5 }),
		];
		const tails = foldRepeatTail(groupIntoBands(rows)).filter(
			(b) => b.kind === "repeatTail",
		);
		expect(tails).toHaveLength(2);
	});

	it("does not merge two adjacent blocks that share an iteration index", () => {
		// Two DIFFERENT repeat blocks, each at iteration 0 but different arities.
		// Grouping on the index alone would fuse them into one band.
		const rows = [
			entry({ minutes: 7 }, { beatId: "a", iteration: 0, iterationCount: 2 }),
			entry({ minutes: 3 }, { beatId: "b", iteration: 0, iterationCount: 5 }),
		];
		const bands = groupIntoBands(rows);
		expect(bands).toHaveLength(2);
		expect(bands.every((b) => b.kind === "iteration")).toBe(true);
	});
});

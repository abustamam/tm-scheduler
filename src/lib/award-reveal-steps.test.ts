import { describe, expect, it } from "vitest";
import {
	clampStep,
	entryStep,
	lastStep,
	revealEntries,
	stepBack,
	stepForward,
	stepView,
} from "./award-reveal-steps";
import type { AwardWinner } from "./project-awards";

const SLIDE = [
	{ key: "best_table_topics", label: "Best Table Topics" },
	{ key: "best_evaluator", label: "Best Evaluator" },
	{ key: "best_speaker", label: "Best Speaker" },
] as const;
const TT: AwardWinner = { category: "best_table_topics", name: "Tess" };
const SP: AwardWinner = { category: "best_speaker", name: "Sam" };

describe("revealEntries", () => {
	// protects=reveal order is the SLIDE's, and only categories with a winner;
	// fails_when=winner order leaks in, or an unwon category is revealed;
	// no_claim=nothing about which winners exist.
	it("follows the slide's order and skips categories without a winner", () => {
		const e = revealEntries([SP, TT], [...SLIDE]);
		expect(e.map((x) => x.key)).toEqual(["best_table_topics", "best_speaker"]);
		expect(e.map((x) => x.name)).toEqual(["Tess", "Sam"]);
	});

	// protects=a winner for a category the deck dropped (live rebuild) is not
	// revealed; fails_when=the snapshot is not intersected with the slide;
	// no_claim=the rebuild wiring (component test).
	it("drops a winner whose category is no longer on the slide, and is empty when none remain", () => {
		const onlyEval = [SLIDE[1]];
		expect(revealEntries([TT, SP], [...onlyEval])).toEqual([]);
	});
});

describe("the step machine", () => {
	// protects=1 + 3N steps, the 7-Next-press contract of AC1; fails_when=the
	// intro or a phase is missing; no_claim=the rendering of any step.
	it("has 1 + 3N steps: N=2 leaves on the 7th Next", () => {
		let step = 0;
		let presses = 0;
		for (;;) {
			presses++;
			const r = stepForward(step, 2);
			if (r.kind === "leave") break;
			step = r.step;
		}
		expect(presses).toBe(7);
		expect(lastStep(2)).toBe(6);
	});

	// protects=phases per category: is, drum, name; fails_when=phases reorder or
	// the intro is skipped; no_claim=pixels.
	it("walks intro, then is / drum / name per category", () => {
		const entries = revealEntries([TT, SP], [...SLIDE]);
		const seen = [0, 1, 2, 3, 4, 5, 6].map((s) => {
			const v = stepView(s, entries);
			return v.kind === "intro" ? "intro" : `${v.entry.key}:${v.phase}`;
		});
		expect(seen).toEqual([
			"intro",
			"best_table_topics:is",
			"best_table_topics:drum",
			"best_table_topics:name",
			"best_speaker:is",
			"best_speaker:drum",
			"best_speaker:name",
		]);
	});

	// protects=confetti only on a forward step INTO a name step (AC5);
	// fails_when=it fires on is/drum steps or on Back; no_claim=the burst itself.
	it("asks for confetti exactly on entering a name step, never going back", () => {
		const fired: number[] = [];
		for (let s = 0; s < lastStep(2); s++) {
			const r = stepForward(s, 2);
			if (r.kind === "step" && r.fireConfetti) fired.push(r.step);
		}
		expect(fired).toEqual([3, 6]);
		expect(stepBack(6, 2)).toEqual({ kind: "step", step: 5 });
		expect(Object.keys(stepBack(3, 2) as object)).not.toContain("fireConfetti");
	});

	// protects=Back on step 0 leaves the slide; fails_when=it sticks or goes
	// negative; no_claim=which slide it lands on.
	it("Back on step 0 leaves", () => {
		expect(stepBack(0, 2)).toEqual({ kind: "leave" });
	});

	// protects=AC6: backward entry shows the last winner, forward starts at 0;
	// fails_when=the two directions share a start; no_claim=the frozen snapshot.
	it("enters forward at step 0 and backward on the last step", () => {
		expect(entryStep("forward", 2)).toBe(0);
		expect(entryStep("back", 2)).toBe(6);
	});

	// protects=a rebuild that shrinks the step count lands on the new last step
	// and Next then leaves, with no confetti; fails_when=a stale step indexes past
	// the entries; no_claim=the rebuild itself.
	it("clamps a stale step to the new last step", () => {
		expect(clampStep(6, 1)).toBe(3);
		expect(stepForward(6, 1)).toEqual({ kind: "leave" });
		const entries = revealEntries([TT], [...SLIDE]);
		const v = stepView(6, entries);
		expect(v.kind === "category" && v.phase).toBe("name");
	});

	// protects=N=0 is inactive (static slide), never a division of the deck into
	// a bare intro; fails_when=N=0 yields entries; no_claim=none.
	it("has no entries, and a lone intro step, for N=0", () => {
		expect(revealEntries([], [...SLIDE])).toEqual([]);
		expect(lastStep(0)).toBe(0);
	});
});

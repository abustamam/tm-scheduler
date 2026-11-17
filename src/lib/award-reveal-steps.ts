// The step machine behind the awards slide's drum-roll reveal (#1654). PURE:
// the deck holds `{ step, frozen }` as state and asks these helpers what to show
// and where Next / Back go.
//
// With N revealed categories there are 1 + 3N steps: step 0 is the title with
// "And the winners are…", then per category (a) "X is…", (b) "X is… drum roll…"
// and (c) the name. Only categories that are on the slide AND have a winner are
// revealed, in the slide's order.
import type { AwardCategoryKey, AwardWinner } from "#/lib/project-awards";

export type RevealEntry = {
	key: AwardCategoryKey;
	label: string;
	name: string;
};

export type RevealPhase = "is" | "drum" | "name";
export type StepView =
	| { kind: "intro" }
	| { kind: "category"; entry: RevealEntry; phase: RevealPhase };

const PHASES: RevealPhase[] = ["is", "drum", "name"];

/** The slide's categories that have a winner, in the slide's order. */
export function revealEntries(
	winners: AwardWinner[],
	categories: { key: AwardCategoryKey; label: string }[],
): RevealEntry[] {
	const names = new Map(winners.map((w) => [w.category, w.name]));
	const out: RevealEntry[] = [];
	for (const c of categories) {
		const name = names.get(c.key);
		if (name) out.push({ key: c.key, label: c.label, name });
	}
	return out;
}

export const lastStep = (n: number): number => 3 * n;

/** A step clamped into 0..last, so a shrinking live rebuild lands on the new
 *  last step. */
export const clampStep = (step: number, n: number): number =>
	Math.max(0, Math.min(step, lastStep(n)));

export function stepView(step: number, entries: RevealEntry[]): StepView {
	if (step <= 0) return { kind: "intro" };
	const idx = Math.min(Math.floor((step - 1) / 3), entries.length - 1);
	return {
		kind: "category",
		entry: entries[idx],
		phase: PHASES[(clampStep(step, entries.length) - 1) % 3],
	};
}

/** Next: a step inside the slide, or `leave` on the last one. */
export function stepForward(
	step: number,
	n: number,
): { kind: "step"; step: number; fireConfetti: boolean } | { kind: "leave" } {
	const at = clampStep(step, n);
	if (at >= lastStep(n)) return { kind: "leave" };
	const to = at + 1;
	return { kind: "step", step: to, fireConfetti: to % 3 === 0 };
}

/** Back: a step inside the slide, or `leave` on step 0. Never confetti. */
export function stepBack(
	step: number,
	n: number,
): { kind: "step"; step: number } | { kind: "leave" } {
	const at = clampStep(step, n);
	return at <= 0 ? { kind: "leave" } : { kind: "step", step: at - 1 };
}

/** The step a slide entry starts on: forwards at 0, backwards on the last
 *  (the final winner shown). */
export const entryStep = (direction: "forward" | "back", n: number): number =>
	direction === "back" ? lastStep(n) : 0;

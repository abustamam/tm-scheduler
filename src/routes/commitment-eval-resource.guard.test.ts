/**
 * The commitment-card evaluation-resource wiring.
 *
 * Comment-blind (`readSource`): both assertions are of the "this pattern must BE
 * present" form, where a comment merely NAMING the pattern would produce a false
 * PASS.
 *
 * What it pins: the card prefers the EVALUATED project over the member's own.
 * An evaluator's slot has no speech, so `ownProjectName` is null for them and
 * `evaluatedProjectName` is null for a plain speaker — the coalescing order is
 * what makes one expression serve both. Reversing it would silently show a
 * General Evaluator their own last project instead of the speech in front of
 * them, with every component test green.
 *
 * The two routes map their commitment rows under different loop variables
 * (`me.tsx` uses `c`, `dashboard.tsx` uses `r`), so the expected coalescing
 * expression is asserted per file rather than shared across both.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES: ReadonlyArray<{ path: string; variable: string }> = [
	{ path: "src/routes/_authed/me.tsx", variable: "c" },
	{ path: "src/routes/_authed/dashboard.tsx", variable: "r" },
];

describe("commitment cards link the evaluation resource", () => {
	for (const { path, variable } of ROUTES) {
		it(`${path} renders EvaluationResourceLinks`, () => {
			// The leading `<` requires the JSX open tag, not just the import —
			// an import-only match would stay green after the render call is
			// deleted.
			expect(readSource(path)).toContain("<EvaluationResourceLinks");
		});

		it(`${path} prefers the evaluated project over the member's own`, () => {
			const src = readSource(path).replace(/\s+/g, " ");
			expect(src).toContain(
				`projectName={${variable}.evaluatedProjectName ?? ${variable}.ownProjectName}`,
			);
		});
	}
});

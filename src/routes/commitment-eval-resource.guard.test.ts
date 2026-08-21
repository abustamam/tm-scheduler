/**
 * The commitment-card evaluation-resource wiring.
 *
 * Comment-blind (`readSource`): every assertion is of the "this pattern must BE
 * present" form, where a comment merely NAMING the pattern would produce a false
 * PASS — and both routes now carry comments quoting `fallback` and the gate.
 *
 * What it pins, and why none of it is reachable from a component test: a route
 * cannot be mounted in vitest, so these are computed prop expressions of exactly
 * the kind CLAUDE.md's props trap describes — a component tested through its
 * props cannot see a WRONG prop.
 *
 * 1. The card prefers the EVALUATED project over the member's own. An
 *    evaluator's slot has no speech, so `ownProjectName` is null for them and
 *    `evaluatedProjectName` is null for a plain speaker — the coalescing order
 *    is what makes one expression serve both. Reversing it would silently show a
 *    General Evaluator their own last project instead of the speech in front of
 *    them, with every component test green.
 * 2. The gate. `EvaluationResourceLinks` renders only for a speaker or an
 *    evaluator; unconditionally it advertised "Generic evaluation resource" on
 *    every functionary row (Timer, Ah-Counter, Grammarian…), which is most of a
 *    typical agenda. Dropping the gate is a one-character edit that no other
 *    test here can see.
 * 3. `fallback` is passed, AND it is CONDITIONAL on the project name being
 *    absent. The prop defaults to FALSE, so without it an evaluator paired with
 *    a TBA speech — spec §3 step 3, the reason 8053 ships at all — would
 *    silently get no form. But passing it UNCONDITIONALLY is the opposite bug
 *    and the one this repo's own docstring calls out: the gate is role-shaped,
 *    so a SPEAKER whose project name matches nothing (a Base-Camp-derived
 *    project the catalog lacks, e.g. Cross-Cultural Understanding, for which TI
 *    publishes 8202E) was handed the generic form, while the project picker —
 *    which passes no `fallback` — correctly showed nothing. Two surfaces
 *    disagreeing about one project, in the direction spec §2 forbids ("a project
 *    with no resource renders no link").
 *
 *    A bare `toContain("fallback")` cannot see that difference: `fallback`,
 *    `fallback={false}` and `fallback={true}` all contain the substring. So the
 *    assertion pins the whole expression.
 *
 * The two routes map their commitment rows under different loop variables
 * (`me.tsx` uses `c`, `dashboard.tsx` uses `r`), so each expectation is
 * asserted per file rather than shared across both.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES: ReadonlyArray<{ path: string; variable: string }> = [
	{ path: "src/routes/_authed/me.tsx", variable: "c" },
	{ path: "src/routes/_authed/dashboard.tsx", variable: "r" },
	// The THIRD card, and the one it would be easiest to forget: the public club
	// page, reached through the anonymous roster pick rather than a session.
	// CLAUDE.md calls that the dominant identity path in this no-auth product, so
	// a card that drifts here misses the most users, not the fewest. It is fed by
	// `listMemberCommitments`, a hand-copy of `loadMyCommitments` — so the copy
	// silently lacking the new columns is exactly the failure this row catches.
	{ path: "src/routes/club.$clubId.index.tsx", variable: "c" },
];

/**
 * Whitespace-insensitive, INCLUDING the spaces Biome adds when it wraps a prop
 * expression across lines (`projectName={\n\t…\n}`). Pinning the wrapping too
 * would fail every time the surrounding JSX gains a level of indentation, which
 * trains people to edit the guard instead of reading it.
 */
const flatten = (src: string) =>
	src.replace(/\s+/g, " ").replace(/\{ /g, "{").replace(/ \}/g, "}");

/** The `<EvaluationResourceLinks … />` element alone, so a prop assertion cannot
 * be satisfied by matching text elsewhere in a 300-line route. */
function element(path: string): string {
	const src = flatten(readSource(path));
	const start = src.indexOf("<EvaluationResourceLinks");
	expect(start, `${path}: no <EvaluationResourceLinks element`).toBeGreaterThan(
		-1,
	);
	const end = src.indexOf("/>", start);
	expect(end, `${path}: element is never closed`).toBeGreaterThan(start);
	return src.slice(start, end + 2);
}

describe("commitment cards link the evaluation resource", () => {
	for (const { path, variable } of ROUTES) {
		it(`${path} renders EvaluationResourceLinks`, () => {
			// The leading `<` requires the JSX open tag, not just the import —
			// an import-only match would stay green after the render call is
			// deleted.
			expect(readSource(path)).toContain("<EvaluationResourceLinks");
		});

		it(`${path} prefers the evaluated project over the member's own`, () => {
			expect(element(path)).toContain(
				`projectName={${variable}.evaluatedProjectName ?? ${variable}.ownProjectName}`,
			);
		});

		it(`${path} opts in to the generic form ONLY for a missing project`, () => {
			// The whole expression, not the substring: `fallback={false}` and a bare
			// `fallback` both contain "fallback", and they mean opposite things.
			expect(element(path)).toContain(
				`fallback={!(${variable}.evaluatedProjectName ?? ${variable}.ownProjectName)}`,
			);
		});

		it(`${path} does not pass fallback unconditionally`, () => {
			// The negative half. A bare `fallback` (or `fallback={true}`) hands a
			// speaker on an uncatalogued project a form that is not their project's.
			const el = element(path);
			expect(el).not.toContain("fallback />");
			expect(el).not.toContain("fallback={true}");
		});

		it(`${path} renders it only for a speaker or an evaluator`, () => {
			// A functionary fails all three arms. `evaluatesSlotId` is the identity
			// of the evaluator arm whatever the club named the role; `roleCategory`
			// catches an evaluator slot not yet pointed at a speaker.
			expect(flatten(readSource(path))).toContain(
				`${variable}.isSpeakerRole || ` +
					`${variable}.evaluatesSlotId !== null || ` +
					`${variable}.roleCategory === "evaluator"`,
			);
		});
	}
});

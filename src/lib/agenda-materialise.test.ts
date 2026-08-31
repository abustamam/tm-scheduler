import { describe, expect, it } from "vitest";
import { BAND_LABELS, materialiseRunOfShow } from "./agenda-materialise";

/**
 * Boundaries are LITERALS, never imported from the module under test.
 *
 * An assertion stated relative to the constant it guards passes for every value
 * of that constant, including one that reintroduces the bug (#519). These
 * numbers were measured from `buildRunOfShow` on 2026-08-25 and are the
 * acceptance criteria in the spec's D2 tables — if the materialiser disagrees,
 * the materialiser is wrong.
 *
 * `bands` is the index, in the ORIGINAL beat list, of the beat each band opens
 * on.
 */
const EXPECTED = {
	false: { beats: 22, handoffs: 4, bands: [0, 4, 7, 10, 18] },
	true: { beats: 23, handoffs: 5, bands: [0, 5, 8, 11, 19] },
} as const;

describe("materialiseRunOfShow", () => {
	for (const variant of [false, true] as const) {
		const want = EXPECTED[`${variant}`];

		it(`emits ${want.beats} beats plus 5 bands for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			expect(seeds).toHaveLength(want.beats + 5);
			expect(seeds.filter((s) => s.kind === "section")).toHaveLength(5);
		});

		it(`opens each band at the right beat for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			const opens = seeds
				.map((s, i) => ({ s, i }))
				.filter(({ s }) => s.kind === "section")
				.map(({ i }, nth) => i - nth);
			expect(opens).toEqual([...want.bands]);
		});

		it(`preserves every hand-off for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			expect(seeds.filter((s) => s.handoff)).toHaveLength(want.handoffs);
		});

		it(`keeps detail tokens VERBATIM for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			// Resolution happens at RENDER time, per row, against that meeting's
			// holders. Resolving here would freeze one evening's names into a
			// template reused every week.
			expect(seeds.some((s) => /\{names:[a-z_]+\}/.test(s.detail ?? ""))).toBe(
				true,
			);
		});

		it(`sortOrder is dense and ascending for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			expect(seeds.map((s) => s.sortOrder)).toEqual(seeds.map((_, i) => i));
		});

		it(`fans speakers out via repeatsRoleKey for geIntro=${variant}`, () => {
			// A speaker beat fans across every matching slot. Materialising it as a
			// literal row instead would give a three-speaker meeting ONE speech.
			const seeds = materialiseRunOfShow(variant);
			expect(seeds.some((s) => s.repeatsRoleKey === "speaker")).toBe(true);
			expect(seeds.some((s) => s.repeatsRoleKey === "evaluator")).toBe(true);
		});
	}

	it("builds for the CLUB's variant, not the frozen RUN_OF_SHOW const", () => {
		// `RUN_OF_SHOW` is `buildRunOfShow({ geIntroducesFunctionaries: false })`
		// with the variant baked in (agenda-runsheet.ts). Reading it instead of
		// building per club gives MCF the 22-beat sheet and silently drops
		// `geOpeningHandoff`. This is the assertion that fails if anyone does.
		const withGe = materialiseRunOfShow(true);
		const without = materialiseRunOfShow(false);
		expect(withGe.length - without.length).toBe(1);
		expect(withGe.filter((s) => s.handoff).length).toBe(
			without.filter((s) => s.handoff).length + 1,
		);
	});

	it("emits the five bands in order", () => {
		expect([...BAND_LABELS]).toEqual([
			"OPENING",
			"SPEECHES",
			"TABLE TOPICS",
			"EVALUATIONS",
			"CLOSING",
		]);
	});

	it("qualifies every {roles} token with its group", () => {
		// A materialised beat has no `requiresGroup` (D1 drops gating), so the
		// group has to travel inside the token or the list cannot resolve later.
		const seeds = materialiseRunOfShow(true);
		const rolesTokens = seeds
			.map((s) => s.detail ?? "")
			.filter((d) => d.includes("{roles"));
		expect(rolesTokens.length).toBeGreaterThan(0);
		for (const d of rolesTokens) {
			expect(d).toMatch(/\{roles:(functionaries|reportingFunctionaries)\}/);
		}
	});
});

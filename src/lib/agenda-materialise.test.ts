import { describe, expect, it } from "vitest";
import { BAND_LABELS, materialiseRunOfShow } from "./agenda-materialise";

/**
 * Boundaries are LITERALS, never imported from the module under test.
 *
 * An assertion stated relative to the constant it guards passes for every value
 * of that constant, including one that reintroduces the bug (#519). These
 * numbers were measured from `buildRunOfShow` on 2026-08-25, re-measured on
 * 2026-09-11, and are the acceptance criteria in the spec's D2 tables — if the
 * materialiser disagrees, the materialiser is wrong.
 *
 * `beats` counts EMITTED beat rows, which is no longer the same as the number
 * of beats `buildRunOfShow` returns: since #719 the speaker beat carries a
 * `preamble` and seeds two rows, so the count is one higher than the template's
 * length in both variants. `bands` is the seed index of each band opener minus
 * the sections before it, which used to equal the beat index for the same
 * reason and now does not past SPEECHES.
 */
const EXPECTED = {
	false: { beats: 23, handoffs: 5, bands: [0, 4, 8, 11, 19] },
	true: { beats: 24, handoffs: 6, bands: [0, 5, 9, 12, 20] },
} as const;

describe("materialiseRunOfShow table topics window (#443)", () => {
	/** The Table Topics beat seed, whichever index it lands at. */
	const ttSeed = (seeds: ReturnType<typeof materialiseRunOfShow>) =>
		seeds.find(
			(s) => s.roleKey === "table_topics_master" && s.markRed !== null,
		);

	it("FREEZES the club's marks, not ours, into the template row", () => {
		// `beatSeed` persists these into mark_green/mark_yellow/mark_red, and
		// `resolveMarks` makes the stored copy what renders — so materialising
		// without the club's window bakes OUR window into the club's own rows
		// permanently, on every surface including the templated deck.
		const seeds = materialiseRunOfShow(false, {
			minSeconds: 60,
			maxSeconds: 150,
		});
		const tt = ttSeed(seeds);
		expect(tt).toBeDefined();
		// ABSOLUTE minutes from 60s/150s — never `toEqual(TABLE_TOPICS_MARKS)`.
		expect({
			green: tt?.markGreen,
			yellow: tt?.markYellow,
			red: tt?.markRed,
		}).toEqual({ green: 1, yellow: 1.75, red: 2.5 });
	});

	it("freezes the standard window when the club states none", () => {
		// The half that fails if someone hardcodes a club window into the seeder.
		const tt = ttSeed(materialiseRunOfShow(false, null));
		expect(tt).toBeDefined();
		expect({
			green: tt?.markGreen,
			yellow: tt?.markYellow,
			red: tt?.markRed,
		}).toEqual({ green: 1, yellow: 1.5, red: 2 });
	});
});

describe("materialiseRunOfShow", () => {
	for (const variant of [false, true] as const) {
		const want = EXPECTED[`${variant}`];

		it(`emits ${want.beats} beats plus 5 bands for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant, null);
			expect(seeds).toHaveLength(want.beats + 5);
			expect(seeds.filter((s) => s.kind === "section")).toHaveLength(5);
		});

		it(`opens each band at the right beat for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant, null);
			const opens = seeds
				.map((s, i) => ({ s, i }))
				.filter(({ s }) => s.kind === "section")
				.map(({ i }, nth) => i - nth);
			expect(opens).toEqual([...want.bands]);
		});

		it(`preserves every hand-off for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant, null);
			expect(seeds.filter((s) => s.handoff)).toHaveLength(want.handoffs);
		});

		it(`keeps detail tokens VERBATIM for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant, null);
			// Resolution happens at RENDER time, per row, against that meeting's
			// holders. Resolving here would freeze one evening's names into a
			// template reused every week.
			expect(seeds.some((s) => /\{names:[a-z_]+\}/.test(s.detail ?? ""))).toBe(
				true,
			);
		});

		it(`sortOrder is dense and ascending for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant, null);
			expect(seeds.map((s) => s.sortOrder)).toEqual(seeds.map((_, i) => i));
		});

		it(`fans speakers out via repeatsRoleKey for geIntro=${variant}`, () => {
			// A speaker beat fans across every matching slot. Materialising it as a
			// literal row instead would give a three-speaker meeting ONE speech.
			const seeds = materialiseRunOfShow(variant, null);
			expect(seeds.some((s) => s.repeatsRoleKey === "speaker")).toBe(true);
			expect(seeds.some((s) => s.repeatsRoleKey === "evaluator")).toBe(true);
		});
	}

	it("builds for the CLUB's variant, not the frozen RUN_OF_SHOW const", () => {
		// `RUN_OF_SHOW` is `buildRunOfShow({ geIntroducesFunctionaries: false })`
		// with the variant baked in (agenda-runsheet.ts). Reading it instead of
		// building per club gives MCF the 22-beat sheet and silently drops
		// `geOpeningHandoff`. This is the assertion that fails if anyone does.
		const withGe = materialiseRunOfShow(true, null);
		const without = materialiseRunOfShow(false, null);
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
		const seeds = materialiseRunOfShow(true, null);
		const rolesTokens = seeds
			.map((s) => s.detail ?? "")
			.filter((d) => d.includes("{roles"));
		expect(rolesTokens.length).toBeGreaterThan(0);
		for (const d of rolesTokens) {
			expect(d).toMatch(/\{roles:(functionaries|reportingFunctionaries)\}/);
		}
	});
});

// #719 — the speech preamble has to survive materialisation, or a club that
// opened the agenda editor once silently loses the beat introducing each
// speech's evaluator while every other club keeps it.
describe("materialiseRunOfShow seeds the speech preamble (#719)", () => {
	const preambleOf = (seeds: ReturnType<typeof materialiseRunOfShow>) =>
		seeds.find((s) => s.detail?.includes("{evaluator:paired}"));

	it("emits a Toastmaster row immediately BEFORE the speech row", () => {
		const seeds = materialiseRunOfShow(false, null);
		const at = seeds.findIndex((s) => s.detail?.includes("{evaluator:paired}"));
		expect(at).toBeGreaterThan(-1);
		expect(seeds[at + 1]?.repeatsRoleKey).toBe("speaker");
	});

	it("carries the tokens VERBATIM, so they resolve per meeting", () => {
		// ABSOLUTE strings. Stated as `beat.preamble.detail` this would pass for a
		// seeder that emitted an empty row, and stated as "contains Evaluator" it
		// would pass for a row that had already frozen one evening's names in.
		expect(preambleOf(materialiseRunOfShow(false, null))?.detail).toBe(
			"Introduces the {role:evaluator}{evaluator:paired} · asks for the speech objectives and timing",
		);
	});

	it("is the Toastmaster's, 0 minutes, untimed, and inside the speaker block", () => {
		const p = preambleOf(materialiseRunOfShow(false, null));
		expect(p?.roleKey).toBe("toastmaster_of_the_day");
		expect(p?.minutes).toBe(0);
		// A hand-off, so the print layouts give it the compact band an adopted
		// sheet needs to keep fitting one page — the same flag the code-derived
		// row carries, which is what `agenda-adoption-parity.test.ts` counts.
		expect(p?.handoff).toBe(true);
		// Inside the SPEAKER's repeat block, which is what interleaves it — one
		// introduction before each speech rather than all of them up front.
		expect(p?.repeatsRoleKey).toBe("speaker");
		expect([p?.markGreen, p?.markYellow, p?.markRed]).toEqual([
			null,
			null,
			null,
		]);
	});

	it("lands on BOTH club variants", () => {
		expect(preambleOf(materialiseRunOfShow(true, null))).toBeDefined();
		expect(preambleOf(materialiseRunOfShow(false, null))).toBeDefined();
	});
});

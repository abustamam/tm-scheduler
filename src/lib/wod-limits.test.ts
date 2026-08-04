// #519 — the WRITE half of the two-layer defence on the public role-sheet PDF
// route. `RENDER_CAPS` in `server/role-sheet-layout.ts` is the load-bearing
// half (it bounds whatever actually reaches react-pdf, including rows written
// before this cap existed); these assertions cover the half that stops new
// oversized values being stored at all.
//
// The validators live beside the limits precisely so they can be tested:
// `server/meetings.ts` composes them into three schemas but may not export
// them, because it is a server-fn module. That rule is enforced by
// `server-modules.guard.test.ts`, which rejected the first version of this fix.

import { describe, expect, it } from "vitest";
import { WOD_FIELDS, WOD_LIMITS } from "./wod-limits";

describe("Word-of-the-Day write caps (#519)", () => {
	const cases = [
		["word", WOD_FIELDS.word, WOD_LIMITS.word],
		["definition", WOD_FIELDS.definition, WOD_LIMITS.definition],
		["example", WOD_FIELDS.example, WOD_LIMITS.example],
	] as const;

	for (const [name, field, limit] of cases) {
		it(`accepts a ${name} exactly at the cap`, () => {
			// Boundary on the ALLOWED side: an off-by-one that rejected the limit
			// itself would be invisible to a test that only tries obvious values.
			expect(field.safeParse("a".repeat(limit)).success).toBe(true);
		});

		it(`rejects a ${name} one character over the cap`, () => {
			expect(field.safeParse("a".repeat(limit + 1)).success).toBe(false);
		});

		it(`rejects the ${name} payload that made the route slow`, () => {
			// The measured attack: 50,000 characters took 3,596ms of synchronous
			// layout against an 87ms baseline.
			expect(field.safeParse("a".repeat(50_000)).success).toBe(false);
		});

		it(`trims the ${name} BEFORE measuring it`, () => {
			// Order matters: `.max()` before `.trim()` would reject a valid value
			// padded with whitespace, and would also let padding count toward the
			// cap. Assert both directions.
			const padded = `${"a".repeat(limit)}      `;
			const parsed = field.safeParse(padded);
			expect(parsed.success).toBe(true);
			expect(parsed.success && parsed.data.length).toBe(limit);
		});
	}

	it("leaves every real value in the database well inside the caps", () => {
		// The bound is only defensible if it never fires on real input. These are
		// the longest values on record when the cap was chosen: a 50-character
		// definition, a 58-character example, and a 14-character word.
		expect(WOD_FIELDS.word.safeParse("Cumbersomeness").success).toBe(true);
		expect(
			WOD_FIELDS.definition.safeParse(
				"clumsy or unwieldy; hard to handle because of size or weight",
			).success,
		).toBe(true);
		expect(
			WOD_FIELDS.example.safeParse(
				"The cumbersomeness of the old projector made every meeting start late.",
			).success,
		).toBe(true);
		// ...with an order of magnitude to spare, so a wordier club is not blocked.
		expect(WOD_LIMITS.definition).toBeGreaterThanOrEqual(500);
	});
});

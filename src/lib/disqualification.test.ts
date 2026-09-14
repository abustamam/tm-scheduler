/**
 * The disqualification reason's cap and validator (#723).
 *
 * The ceiling below is stated as an ABSOLUTE number, never relative to the
 * constant it guards. `expect(reason).toBeLessThanOrEqual(DISQUALIFICATION_LIMITS.reason)`
 * passes for every value of that constant, including one that reintroduces the
 * bug — the trap `CODING_STANDARDS.md` records from #519, where raising a limit
 * to 49,999 kept 103/103 green at 3.7s of blocked event loop. This file exists
 * so the cap cannot be raised without someone typing a new number HERE and
 * saying why.
 */
import { describe, expect, it } from "vitest";
import {
	capDisqualificationReason,
	DISQUALIFICATION_LIMITS,
	DISQUALIFICATION_PRESETS,
	disqualificationReasonSchema,
} from "./disqualification";

describe("DISQUALIFICATION_LIMITS (#723)", () => {
	// 200 code points, not the 120 shipped — headroom for a club that wants a
	// fuller sentence, far below anything that changes the cost of a page. The
	// string is one clause beside a name on a phone-width ballot card and reaches
	// no synchronous PDF renderer (#723 keeps disqualification off the printed
	// agenda and the projected deck). Raising the constant past this is a
	// deliberate act, which is the point.
	it("the reason cap stays under an absolute ceiling", () => {
		expect(DISQUALIFICATION_LIMITS.reason).toBeLessThanOrEqual(200);
	});

	// The floor matters too, and in the opposite direction: a cap set below the
	// presets would make the product's own one-tap answers un-submittable — a
	// self-inflicted rejection nothing else would catch, because the presets
	// never go through the client-side `maxLength`.
	it("every preset fits under the cap", () => {
		for (const preset of DISQUALIFICATION_PRESETS) {
			expect(disqualificationReasonSchema.safeParse(preset).success).toBe(true);
		}
	});
});

describe("disqualificationReasonSchema (#723)", () => {
	it("trims, and rejects a reason that is only whitespace", () => {
		expect(disqualificationReasonSchema.parse("  outside  ")).toBe("outside");
		// The column is NOT NULL; without this the constraint means nothing, since
		// a row of spaces satisfies the database and tells the room nothing.
		expect(disqualificationReasonSchema.safeParse("   ").success).toBe(false);
		expect(disqualificationReasonSchema.safeParse("").success).toBe(false);
	});

	it("trims BEFORE measuring, so trailing space cannot push a valid reason over", () => {
		const atCap = "x".repeat(DISQUALIFICATION_LIMITS.reason);
		expect(disqualificationReasonSchema.safeParse(`${atCap}   `).success).toBe(
			true,
		);
		expect(disqualificationReasonSchema.safeParse(`${atCap}x`).success).toBe(
			false,
		);
	});
});

describe("capDisqualificationReason (#723)", () => {
	it("leaves a reason that fits untouched", () => {
		expect(capDisqualificationReason("Outside the window")).toBe(
			"Outside the window",
		);
	});

	// The render-side half, for a row written by any future path that skips the
	// schema — the column is unbounded `text` and this reaches every phone in
	// the room. Measured in CODE POINTS, which is why the astral case is here:
	// a `.slice()` would cut a surrogate pair and emit a lone surrogate (#522).
	it("bounds an over-long reason in code points, astral included", () => {
		const long = capDisqualificationReason("a".repeat(10_000));
		expect([...long].length).toBeLessThanOrEqual(
			DISQUALIFICATION_LIMITS.reason,
		);
		const emoji = capDisqualificationReason("😀".repeat(10_000));
		expect([...emoji].length).toBeLessThanOrEqual(
			DISQUALIFICATION_LIMITS.reason,
		);
		expect(emoji).not.toMatch(/[\uD800-\uDFFF]/u);
	});
});

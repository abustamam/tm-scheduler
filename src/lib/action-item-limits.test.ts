import { describe, expect, it } from "vitest";
import {
	ACTION_ITEM_FIELDS,
	ACTION_ITEM_LIMITS,
	ACTION_ITEM_RENDER_CAPS,
} from "./action-item-limits";

describe("ACTION_ITEM_LIMITS", () => {
	// Absolute ceilings, not assertions relative to the constants themselves.
	// `expect(v.length).toBeLessThanOrEqual(CAP)` passes for every value of CAP,
	// including one that reintroduces the very cost the cap exists to bound.
	it("caps the item text at 300 characters", () => {
		expect(ACTION_ITEM_LIMITS.text).toBe(300);
	});

	it("keeps the text cap far below the prose-sized fields", () => {
		// A action item is a sentence, not a paragraph. `notes` and the
		// announcements field sit at 2,000; this must stay an order below them,
		// because unlike those two this one renders into the minutes PDF.
		expect(ACTION_ITEM_LIMITS.text).toBeLessThan(500);
	});
});

describe("ACTION_ITEM_RENDER_CAPS", () => {
	it("bounds how many action-item rows reach the minutes PDF", () => {
		expect(ACTION_ITEM_RENDER_CAPS.rows).toBe(40);
	});

	it("keeps the row cap inside the measured flat region of the renderer", () => {
		// `minutes-render-caps.ts` measured the same renderer: flat to ~500 rows,
		// super-linear past it (2,000 → 2.5s, 5,000 → 19.6s), and sized against
		// ASTRAL text because emoji rows cost ~13x ASCII at the same length.
		// 40 is in the same family as the neighbouring caps (programRows 60,
		// tableTopicsRows 40) and nowhere near the knee.
		expect(ACTION_ITEM_RENDER_CAPS.rows).toBeLessThanOrEqual(60);
	});

	it("caps the owner name printed beside an item", () => {
		expect(ACTION_ITEM_RENDER_CAPS.ownerName).toBe(120);
	});
});

describe("ACTION_ITEM_FIELDS — write validation REJECTS", () => {
	// Reject rather than truncate. That is safe here only because this surface is
	// an online admin form where a rejection costs the field being typed — action
	// items are read-only on the meeting page and never enter the offline minutes
	// queue, where a rejecting cap is a poison pill that freezes every later
	// write for that meeting (#525/#526).
	it("accepts text at exactly the cap", () => {
		const at = "x".repeat(ACTION_ITEM_LIMITS.text);
		expect(ACTION_ITEM_FIELDS.text.parse(at)).toBe(at);
	});

	it("rejects text one character over the cap", () => {
		const over = "x".repeat(ACTION_ITEM_LIMITS.text + 1);
		expect(() => ACTION_ITEM_FIELDS.text.parse(over)).toThrow();
	});

	it("rejects empty text", () => {
		expect(() => ACTION_ITEM_FIELDS.text.parse("   ")).toThrow();
	});

	it("gives a readable message rather than a serialized validation dump", () => {
		// `ZodError.message` is `JSON.stringify(issues)` and the form renders it
		// straight into a toast, so a missing message puts raw JSON in front of a
		// club officer.
		const over = "x".repeat(ACTION_ITEM_LIMITS.text + 1);
		const result = ACTION_ITEM_FIELDS.text.safeParse(over);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.issues[0].message).toMatch(/under 300 characters/);
	});

	it("trims surrounding whitespace", () => {
		expect(ACTION_ITEM_FIELDS.text.parse("  book the venue  ")).toBe(
			"book the venue",
		);
	});
});

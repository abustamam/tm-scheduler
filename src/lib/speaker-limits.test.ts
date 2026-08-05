// The speaker-detail write caps (#522).
//
// Both halves of every cap are tested here: that it REJECTS on the create path,
// that it TRUNCATES on the update path, and — the part that is easy to get
// wrong — that the number itself stays inside an ABSOLUTE range at both ends.
import { describe, expect, it } from "vitest";
import { MINUTES_RENDER_CAPS } from "./minutes-render-caps";
import {
	clampSpeechWindow,
	SPEAKER_FIELDS,
	SPEAKER_LIMITS,
	SPEAKER_UPDATE_FIELDS,
	speechMinutesField,
	speechMinutesUpdateField,
} from "./speaker-limits";

const STRING_KEYS = [
	"speechTitle",
	"introduction",
	"pathwayPath",
	"projectName",
	"projectLevel",
	"presentationUrl",
] as const;

describe("SPEAKER_FIELDS — the create path REJECTS over-long input", () => {
	it.each(STRING_KEYS)("rejects a %s one character over the cap", (key) => {
		const over = "x".repeat(SPEAKER_LIMITS[key] + 1);
		expect(SPEAKER_FIELDS[key].safeParse(over).success).toBe(false);
	});

	it.each(STRING_KEYS)("accepts a %s exactly at the cap", (key) => {
		const at = "x".repeat(SPEAKER_LIMITS[key]);
		expect(SPEAKER_FIELDS[key].safeParse(at).success).toBe(true);
	});

	it.each(
		STRING_KEYS,
	)("rejects %s with a HUMAN message, not raw JSON", (key) => {
		// The claim sheet renders `ZodError.message` straight into a toast, and
		// that property is `JSON.stringify(issues)`. Before #522 these fields had
		// no `.max()`, so the error was unreachable from that form; adding the cap
		// without a message would put a multi-line JSON dump on a public page.
		const r = SPEAKER_FIELDS[key].safeParse(
			"x".repeat(SPEAKER_LIMITS[key] + 1),
		);
		expect(r.success).toBe(false);
		if (r.success) return;
		const message = r.error.issues[0]?.message ?? "";
		expect(message).toMatch(/^Keep the .+ under \d+ characters\.$/);
		expect(message).not.toContain("{");
	});

	it("trims BEFORE measuring, so padding can never push a valid value over", () => {
		const padded = `  ${"x".repeat(SPEAKER_LIMITS.speechTitle)}  `;
		const r = SPEAKER_FIELDS.speechTitle.safeParse(padded);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toHaveLength(SPEAKER_LIMITS.speechTitle);
	});
});

describe("SPEAKER_UPDATE_FIELDS — the update path TRUNCATES instead", () => {
	it.each(STRING_KEYS)("truncates an over-long %s to the cap", (key) => {
		const over = "x".repeat(SPEAKER_LIMITS[key] * 2);
		const r = SPEAKER_UPDATE_FIELDS[key].safeParse(over);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toHaveLength(SPEAKER_LIMITS[key]);
	});

	it.each(STRING_KEYS)("leaves a %s that is already short alone", (key) => {
		const r = SPEAKER_UPDATE_FIELDS[key].safeParse("Ice Breaker");
		expect(r.success && r.data).toBe("Ice Breaker");
	});

	/**
	 * Every truncation fixture above is `"x".repeat(...)` — one axis, all ASCII.
	 * #522's review showed that hid a real defect: the original `.slice()` cut a
	 * surrogate pair in half, so `"a" + "🎤".repeat(150)` truncated to a
	 * 200-unit string ending in a lone high surrogate, which react-pdf renders
	 * as a tombstone and which is invalid in a PDF text string. Truncation now
	 * goes through the audited `cap`.
	 */
	it.each(STRING_KEYS)("never splits a surrogate pair truncating %s", (key) => {
		const r = SPEAKER_UPDATE_FIELDS[key].safeParse(
			`a${"🎤".repeat(SPEAKER_LIMITS[key])}`,
		);
		expect(r.success).toBe(true);
		if (!r.success) return;
		const trailing = r.data.charCodeAt(r.data.length - 1);
		expect(trailing >= 0xd800 && trailing <= 0xdbff).toBe(false);
		// No lone surrogate anywhere, not just at the cut.
		expect(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
				r.data,
			),
		).toBe(false);
	});

	it.each(STRING_KEYS)("bounds %s by CODE POINTS on astral input", (key) => {
		// The bound is code points, so an all-astral value can still reach
		// `2 * max` UTF-16 units. That is bounded, which is what matters — but it
		// means `.length` is the wrong thing to assert.
		const r = SPEAKER_UPDATE_FIELDS[key].safeParse("😀".repeat(100_000));
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect([...r.data].length).toBeLessThanOrEqual(SPEAKER_LIMITS[key]);
	});

	it("truncates a hostile 8MB value without rejecting it", () => {
		// The lockout case this variant exists for: a value stored before the cap
		// must not be what stops an admin repairing it.
		const r = SPEAKER_UPDATE_FIELDS.speechTitle.safeParse(
			"x".repeat(8_000_000),
		);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toHaveLength(SPEAKER_LIMITS.speechTitle);
	});
});

describe("speech minutes are bounded at both ends", () => {
	it("rejects a duration past the bound on create", () => {
		expect(
			speechMinutesField.safeParse(SPEAKER_LIMITS.maxSpeechMinutes + 1).success,
		).toBe(false);
	});

	it("accepts a duration at the bound on create", () => {
		expect(
			speechMinutesField.safeParse(SPEAKER_LIMITS.maxSpeechMinutes).success,
		).toBe(true);
	});

	it("accepts an over-cap value at the FIELD level on update", () => {
		// The update field deliberately does not clamp — `clampSpeechWindow` runs
		// after the object refinement instead, so the order check reads what the
		// caller actually sent. See the schema test for the composed behaviour.
		expect(speechMinutesUpdateField.safeParse(999_999).success).toBe(true);
	});

	it("clamps both ends onto the cap, leaving in-range values alone", () => {
		expect(clampSpeechWindow({ minMinutes: 700, maxMinutes: 900 })).toEqual({
			minMinutes: SPEAKER_LIMITS.maxSpeechMinutes,
			maxMinutes: SPEAKER_LIMITS.maxSpeechMinutes,
		});
		expect(clampSpeechWindow({ minMinutes: 5, maxMinutes: 7 })).toEqual({
			minMinutes: 5,
			maxMinutes: 7,
		});
	});

	it("leaves an absent end absent rather than clamping undefined to the cap", () => {
		expect(clampSpeechWindow({})).toEqual({
			minMinutes: undefined,
			maxMinutes: undefined,
		});
	});

	it("still rejects zero, negative and fractional durations on both paths", () => {
		for (const schema of [speechMinutesField, speechMinutesUpdateField]) {
			expect(schema.safeParse(0).success).toBe(false);
			expect(schema.safeParse(-5).success).toBe(false);
			expect(schema.safeParse(4.5).success).toBe(false);
		}
	});

	it("keeps a value that would overflow the integer column out of the driver", () => {
		// The column is `integer`. Before the bound, anything past 2^31 reached the
		// driver and surfaced as a 500 rather than a validation error.
		expect(speechMinutesField.safeParse(2_147_483_648).success).toBe(false);
	});
});

/**
 * The caps are only a defence at a SPECIFIC size, and a test written against
 * the constant cannot see that.
 *
 * `expect(value.length).toBeLessThanOrEqual(SPEAKER_LIMITS.speechTitle)` passes
 * for every possible cap, including one that reintroduces the bug — that is
 * exactly how #519 shipped a `speakerRows` of 5,000 with 90/90 green while a
 * single public request cost 129 seconds of blocked event loop. So these
 * assertions name ABSOLUTE numbers, measured off the real cost curve.
 *
 * Measured for this change on a 12-row program list — the shape
 * `minutes-pdf-logic.ts` actually renders — through the same
 * `@react-pdf/renderer` that serves it:
 *
 *   500 chars/row →     25 ms      20,000 chars/row →    656 ms
 *   2,000 chars/row →   52 ms     100,000 chars/row → 16,722 ms
 *   5,000 chars/row →  111 ms
 *
 * Flat to 5,000, then superlinear: 100,000 is 16.7 SECONDS of a single Node
 * process (ADR-0007) doing nothing else. The ceilings below sit an order of
 * magnitude under the knee.
 */
describe("the caps stay inside an absolute, measured range", () => {
	it("keeps every single field far below the render knee", () => {
		for (const key of STRING_KEYS) {
			expect(SPEAKER_LIMITS[key]).toBeLessThanOrEqual(2_000);
		}
	});

	it("keeps the field that reaches a PDF tightest of all", () => {
		// `speechTitle` is the only speaker field rendered into a server-side PDF,
		// and it is rendered once PER PROGRAM ROW, so its cap is multiplied.
		expect(SPEAKER_LIMITS.speechTitle).toBeLessThanOrEqual(500);
	});

	it("keeps the WHOLE record below the knee, not just each field", () => {
		// The per-field ceilings above are individually satisfiable by a set of
		// caps whose sum is not. One request writes all of them at once.
		const total = STRING_KEYS.reduce((n, k) => n + SPEAKER_LIMITS[k], 0);
		expect(total).toBeLessThanOrEqual(5_000);
	});

	it("bounds a speech window to something a meeting could contain", () => {
		expect(SPEAKER_LIMITS.maxSpeechMinutes).toBeLessThanOrEqual(1_440);
	});

	/**
	 * The minutes PDF declares its OWN render caps, and the first version of
	 * #522 left them module-private — reproducing trap 5 inside the change that
	 * cites trap 5. `MINUTES_RENDER_CAPS.name` could be set to 5,000,000 with
	 * all 57 tests green, restoring exactly the cost this change exists to
	 * bound, because the only thing watching them was a source-grep on the
	 * SYMBOL. They are exported now so the NUMBER is assertable.
	 */
	it("keeps the minutes render caps on the flat part of the same curve", () => {
		for (const key of [
			"name",
			"roleName",
			"club",
			"theme",
			"word",
			"topic",
		] as const) {
			expect(MINUTES_RENDER_CAPS[key]).toBeLessThanOrEqual(500);
		}
		// The joined attendance line is one string holding a whole club's names,
		// so it gets more room than a single name — still far under the knee.
		expect(MINUTES_RENDER_CAPS.namesLine).toBeLessThanOrEqual(5_000);
	});

	/**
	 * The ROW-COUNT ceilings, which are the half the first pass missed. Cost is
	 * super-linear in row count even when every row is short, and the count is
	 * writable with no session. Measured through the same renderer with
	 * ordinary, well-capped rows: 200 rows 102ms, 500 285ms, 2,000 2,477ms,
	 * 5,000 19,581ms. Flat to ~500, so the ceiling goes an order of magnitude
	 * under that.
	 */
	it("bounds how many rows the minutes PDF will lay out", () => {
		expect(MINUTES_RENDER_CAPS.programRows).toBeLessThanOrEqual(500);
		expect(MINUTES_RENDER_CAPS.tableTopicsRows).toBeLessThanOrEqual(500);
		expect(MINUTES_RENDER_CAPS.awardRows).toBeLessThanOrEqual(500);
		// …and still leaves room for any meeting a club would really hold.
		expect(MINUTES_RENDER_CAPS.programRows).toBeGreaterThanOrEqual(40);
	});

	/**
	 * The LOWER bound, which is a real constraint and not symmetry for its own
	 * sake. `applyProjectDisplay` (#418) overwrites `projectName` from the
	 * Pathways catalog AFTER this schema runs, so a cap below the catalog's own
	 * longest value is one the application itself violates on every
	 * project-linked speech — and the render cap would then elide a name the
	 * club did not type and cannot shorten.
	 *
	 * Longest `pathways_projects.name` on record: 56. Longest
	 * `pathways_paths.name`: 23.
	 */
	it("leaves room for the longest name the CATALOG itself writes", () => {
		expect(SPEAKER_LIMITS.projectName).toBeGreaterThanOrEqual(56);
		expect(SPEAKER_LIMITS.pathwayPath).toBeGreaterThanOrEqual(23);
	});

	it("leaves room for the longest values real speeches contain", () => {
		// Observed maxima in the speeches table: title 23, project_name 38,
		// pathway_path 23, project_level 7. Nothing a club has actually typed
		// should be rejected or truncated by this change.
		expect(SPEAKER_LIMITS.speechTitle).toBeGreaterThanOrEqual(23);
		expect(SPEAKER_LIMITS.projectLevel).toBeGreaterThanOrEqual(7);
		expect(SPEAKER_LIMITS.maxSpeechMinutes).toBeGreaterThanOrEqual(60);
	});
});

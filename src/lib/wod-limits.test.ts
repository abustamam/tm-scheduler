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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import { WOD_FIELDS, WOD_LIMITS, WOD_UPDATE_FIELDS } from "./wod-limits";

describe("Word-of-the-Day write caps (#519)", () => {
	const cases = [
		["word", WOD_FIELDS.word, WOD_UPDATE_FIELDS.word, WOD_LIMITS.word],
		[
			"definition",
			WOD_FIELDS.definition,
			WOD_UPDATE_FIELDS.definition,
			WOD_LIMITS.definition,
		],
		[
			"example",
			WOD_FIELDS.example,
			WOD_UPDATE_FIELDS.example,
			WOD_LIMITS.example,
		],
	] as const;

	for (const [name, field, updateField, limit] of cases) {
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

		// The UPDATE family, per field. The only behavioural assertion on it below
		// runs `definition` alone, so deleting the `.transform` from `word` and
		// `example` — leaving them bare `z.string().trim()` — left the FULL suite
		// green (3,023 tests, verified by mutation) with the write cap gone from
		// two of the three fields. `wordOfTheDay` is the one of those two that
		// reaches the PDF, and the public Grammarian edit path (#296) writes it.
		// The source guard cannot see this: it reads `meetings.ts`, which still
		// says `WOD_UPDATE_FIELDS.word` whatever that validator does.
		it(`truncates a ${name} one character over the cap on the update paths`, () => {
			const parsed = updateField.safeParse("a".repeat(limit + 1));
			expect(parsed.success).toBe(true);
			expect(parsed.success && parsed.data.length).toBe(limit);
		});

		it(`leaves a ${name} exactly at the cap untouched on the update paths`, () => {
			// The boundary on the other side: an off-by-one that shaved a character
			// off every legal value would be invisible to an over-cap test alone.
			const exact = "a".repeat(limit);
			expect(updateField.parse(exact)).toBe(exact);
		});
	}

	it("leaves every real value in the database well inside the caps", () => {
		// The bound is only defensible if it never fires on real input. The
		// longest values on record when the cap was chosen were a 14-character
		// word, a 50-character definition and a 58-character example; the
		// fixtures below are a little longer than those (60 and 70) and still
		// land far inside the caps.
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

	it("truncates rather than rejecting on the update paths", () => {
		// The whole point of the second family: a legacy row must not be able to
		// fail an edit. Over-long input comes back SHORTENED, not as an error.
		const over = "a".repeat(50_000);
		const parsed = WOD_UPDATE_FIELDS.definition.safeParse(over);
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.length).toBe(WOD_LIMITS.definition);
		// ...and the same input is REJECTED by the create-side family, so the two
		// are genuinely different and not an accidental copy.
		expect(WOD_FIELDS.definition.safeParse(over).success).toBe(false);
	});

	it("leaves a value inside the cap untouched on the update paths", () => {
		const fine = "clumsy or unwieldy";
		expect(WOD_UPDATE_FIELDS.definition.parse(fine)).toBe(fine);
		expect(WOD_UPDATE_FIELDS.word.parse("Cumbersomeness")).toBe(
			"Cumbersomeness",
		);
	});

	it("keeps every cap at a length whose LAYOUT COST is small", () => {
		// The assertions above are all stated relative to `WOD_LIMITS` itself, so
		// they pass for any cap; the only absolute number among them is the 50,000
		// rejection, which merely says "under 50,000". That is not a bound on cost.
		// Raising all three limits to 49_999 keeps every test in this file AND
		// every test in `role-sheet-layout.test.ts` green (103/103, verified by
		// mutation) while one public request again costs 3,707ms of blocked event
		// loop — the exact defect #519 is about.
		//
		// So pin a CEILING, not just a floor. Measured on the shipped layout: a
		// 500-character note renders in 39ms and a 5,000-character one in the same
		// 39ms, against 3,707ms at 49,999 — the cost is flat far past these
		// ceilings and only then explodes, so 4x the shipped values leaves ample
		// headroom for a wordier club without ever reaching the knee.
		expect(WOD_LIMITS.word).toBeLessThanOrEqual(240);
		expect(WOD_LIMITS.definition).toBeLessThanOrEqual(2_000);
		expect(WOD_LIMITS.example).toBeLessThanOrEqual(2_000);
	});
});

/**
 * The validators above are only a defence if `server/meetings.ts` actually
 * COMPOSES them, and nothing else can see that it does.
 *
 * `meetings.ts` is a server-fn module: its three schemas are private and reach
 * the world only through a `createServerFn` validator, which vitest cannot
 * invoke outside a request context. That is the same hole `outreach-authz` and
 * `actor-provenance` are guarded for, and it is wide here — reverting all three
 * fields to `z.string().trim().optional()` and deleting the import leaves the
 * FULL suite green (3,016 tests, verified by mutation) with the write cap gone.
 *
 * Read through `#/test/guard-source`: this is a "the pattern must BE present"
 * guard, so a comment mentioning `WOD_FIELDS.definition` would otherwise
 * satisfy it exactly as well as the real composition.
 */
describe("meetings.ts composes the Word-of-the-Day caps (#519)", () => {
	const src = readSource(
		resolve(dirname(fileURLToPath(import.meta.url)), "../server/meetings.ts"),
	);

	// Field name → the validator it must be built from. Keyed on the FIELD, so a
	// new schema that adds `wodDefinition` with a bare `z.string()` is caught by
	// the count assertion below rather than slipping past a per-name check.
	// Field name → the validator family it must be built from. Both families cap
	// at the same limits; they differ in what happens when a value exceeds them.
	const FIELDS = ["wordOfTheDay", "wodDefinition", "wodExample"] as const;

	for (const field of FIELDS) {
		it(`declares every ${field} from a capped validator`, () => {
			// Only SCHEMA declarations — a value built from a validator. The handlers
			// below each schema also write `wodExample: data.wodExample`, which is a
			// pass-through, not a declaration.
			const declarations =
				src.match(
					new RegExp(
						`\\b${field}\\s*:\\s*(?:z|WOD_FIELDS|WOD_UPDATE_FIELDS)\\.[^,\\n]*`,
						"g",
					),
				) ?? [];
			// There must BE one — a guard that passes on zero matches goes green the
			// moment the field is renamed out from under it.
			expect(declarations.length).toBeGreaterThan(0);
			for (const d of declarations) {
				expect(d).toMatch(/WOD_(?:UPDATE_)?FIELDS\./);
			}
		});
	}

	// The create/update split is a DECISION, not an accident: create rejects so
	// the author sees an error on new input, update truncates so a row written
	// before the cap cannot lock an admin out of the whole edit form. Encode it,
	// or a later refactor "simplifies" the two families back into one and
	// silently reintroduces the lockout.
	it("rejects on create and truncates on update", () => {
		const createBlock = src.slice(
			src.indexOf("const createMeetingSchema"),
			src.indexOf("const updateMeetingSchema"),
		);
		const updateBlock = src.slice(
			src.indexOf("const updateMeetingSchema"),
			src.indexOf("const updateWordOfTheDaySchema"),
		);
		expect(createBlock).toContain("WOD_FIELDS.word");
		expect(createBlock).not.toContain("WOD_UPDATE_FIELDS");
		for (const v of ["word", "definition", "example"]) {
			expect(updateBlock).toContain(`WOD_UPDATE_FIELDS.${v}`);
		}

		// The WOD-only editor REJECTS: it touches nothing else, so an error costs
		// the author one field, while truncating would silently destroy a legacy
		// definition on a path reachable with no session.
		const wodBlock = src.slice(src.indexOf("const updateWordOfTheDaySchema"));
		expect(wodBlock).toContain("WOD_FIELDS.definition");
		expect(wodBlock.slice(0, wodBlock.indexOf("});"))).not.toContain(
			"WOD_UPDATE_FIELDS",
		);
	});
});

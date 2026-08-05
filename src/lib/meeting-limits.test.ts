// The meeting free-text write caps (#525).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import {
	MEETING_FIELDS,
	MEETING_LIMITS,
	MEETING_UPDATE_FIELDS,
} from "./meeting-limits";
import { MINUTES_RENDER_CAPS } from "./minutes-render-caps";

const REJECT_KEYS = [
	"theme",
	"location",
	"notes",
	"reminders",
	"topic",
] as const;
const TRUNCATE_KEYS = ["theme", "location", "notes", "reminders"] as const;

const here = () => dirname(fileURLToPath(import.meta.url));

const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("MEETING_FIELDS — the create path REJECTS", () => {
	it.each(REJECT_KEYS)("rejects a %s one character over the cap", (key) => {
		const over = "x".repeat(MEETING_LIMITS[key] + 1);
		expect(MEETING_FIELDS[key].safeParse(over).success).toBe(false);
	});

	it.each(REJECT_KEYS)("accepts a %s exactly at the cap", (key) => {
		expect(
			MEETING_FIELDS[key].safeParse("x".repeat(MEETING_LIMITS[key])).success,
		).toBe(true);
	});

	it.each(
		REJECT_KEYS,
	)("rejects %s with a HUMAN message, not raw JSON", (key) => {
		// `ZodError.message` is `JSON.stringify(issues)` and the meeting form
		// renders it straight into a toast, so a cap without a message puts a
		// multi-line JSON dump in front of a club officer.
		const r = MEETING_FIELDS[key].safeParse(
			"x".repeat(MEETING_LIMITS[key] + 1),
		);
		expect(r.success).toBe(false);
		if (r.success) return;
		const message = r.error.issues[0]?.message ?? "";
		expect(message).toMatch(/^Keep the .+ under \d+ characters\.$/);
		expect(message).not.toContain("{");
	});

	it("trims BEFORE measuring, so padding cannot push a valid value over", () => {
		const padded = `  ${"x".repeat(MEETING_LIMITS.theme)}  `;
		const r = MEETING_FIELDS.theme.safeParse(padded);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toHaveLength(MEETING_LIMITS.theme);
	});
});

describe("MEETING_UPDATE_FIELDS — the whole-meeting form TRUNCATES", () => {
	it.each(TRUNCATE_KEYS)("truncates an over-long %s to the cap", (key) => {
		const r = MEETING_UPDATE_FIELDS[key].safeParse(
			"x".repeat(MEETING_LIMITS[key] * 2),
		);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toHaveLength(MEETING_LIMITS[key]);
	});

	it.each(TRUNCATE_KEYS)("leaves a short %s alone", (key) => {
		const r = MEETING_UPDATE_FIELDS[key].safeParse("Courage");
		expect(r.success && r.data).toBe("Courage");
	});

	it.each(
		TRUNCATE_KEYS,
	)("never splits a surrogate pair truncating %s", (key) => {
		// Truncation goes through the audited `cap`, not a bare `.slice()`. A
		// UTF-16 slice leaves a lone surrogate that Postgres encodes to U+FFFD —
		// the defect that shipped twice before it was found (#519, #522).
		const r = MEETING_UPDATE_FIELDS[key].safeParse(
			`a${"🎤".repeat(MEETING_LIMITS[key])}`,
		);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(LONE_SURROGATE.test(r.data)).toBe(false);
	});

	it("truncates a hostile 8MB theme rather than blocking the whole save", () => {
		// The lockout case this variant exists for: `updateMeetingSchema` covers
		// the whole meeting, so rejecting would block saving the DATE over a value
		// the officer cannot see and cannot reach except through this form.
		const r = MEETING_UPDATE_FIELDS.theme.safeParse("x".repeat(8_000_000));
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data).toHaveLength(MEETING_LIMITS.theme);
	});
});

/**
 * ABSOLUTE ceilings, measured off the same cost curve as #522 rather than
 * stated relative to the constants. `expect(x.length).toBeLessThanOrEqual(CAP)`
 * passes for every value of CAP, including one that reintroduces the bug.
 *
 * Measured through `@react-pdf/renderer` on a 12-row list: 2,000 chars/row =
 * 52ms, 5,000 = 111ms, 20,000 = 656ms, 100,000 = 16,722ms. Flat to 5,000, then
 * super-linear.
 */
describe("the caps stay inside an absolute, measured range", () => {
	it("keeps every field far below the render knee", () => {
		for (const key of REJECT_KEYS) {
			expect(MEETING_LIMITS[key]).toBeLessThanOrEqual(2_000);
		}
	});

	it("keeps the two fields that reach a PDF tightest", () => {
		// `theme` and `topic` render into the minutes PDF, once per document and
		// once per Table Topics row respectively.
		expect(MEETING_LIMITS.theme).toBeLessThanOrEqual(500);
		expect(MEETING_LIMITS.topic).toBeLessThanOrEqual(500);
	});

	it("leaves room for everything a club has actually written", () => {
		// Longest on record: theme 20, location 30, reminders 62; notes and topic
		// empty. Nothing real should be rejected or shortened by this change.
		expect(MEETING_LIMITS.theme).toBeGreaterThanOrEqual(60);
		expect(MEETING_LIMITS.location).toBeGreaterThanOrEqual(60);
		expect(MEETING_LIMITS.reminders).toBeGreaterThanOrEqual(500);
		expect(MEETING_LIMITS.notes).toBeGreaterThanOrEqual(500);
		expect(MEETING_LIMITS.topic).toBeGreaterThanOrEqual(60);
	});

	/**
	 * The write cap and the render cap must AGREE, or one of them is a lie.
	 *
	 * If the write cap exceeded the render cap, a value an officer legitimately
	 * saved would be silently elided on the printed minutes. `minutes-render-caps`
	 * imports these rather than declaring its own numbers, so this asserts the
	 * wiring rather than a coincidence — the same one-source property the program
	 * row gets from `SPEAKER_LIMITS.speechTitle`.
	 */
	it("renders every value it accepts on write", () => {
		// `minutes-render-caps.ts` is literally `theme: MEETING_LIMITS.theme`, so
		// comparing the two VALUES is a tautology that cannot fail. What can fail
		// is someone replacing the import with a hardcoded number, so assert the
		// WIRING at the source instead. Comment-blind, because a comment naming
		// `MEETING_LIMITS.theme` would satisfy a raw read just as well.
		const src = readSource(resolve(here(), "./minutes-render-caps.ts"));
		expect(src).toMatch(/theme:\s*MEETING_LIMITS\.theme/);
		expect(src).toMatch(/topic:\s*MEETING_LIMITS\.topic/);
		// And the numbers still have to sit under the render knee on their own.
		expect(MINUTES_RENDER_CAPS.theme).toBeLessThanOrEqual(500);
		expect(MINUTES_RENDER_CAPS.topic).toBeLessThanOrEqual(500);
	});
});

/**
 * The validators above are only a defence if the server modules actually
 * COMPOSE them, and nothing else can see that they do.
 *
 * `meetings.ts` and `minutes.ts` are server-fn modules: their schemas are
 * private and reach the world only through a `createServerFn` validator, which
 * vitest cannot invoke outside a request context. Reverting these fields to
 * `z.string().trim().optional()` and deleting the import leaves the full suite
 * green with the write cap gone.
 *
 * Read comment-blind through `#/test/guard-source` — this is a "the pattern
 * must BE present" guard, so a comment mentioning `MEETING_FIELDS.theme` would
 * otherwise satisfy it exactly as well as the real composition. That is the
 * class the stripper exists for; the "offender must be absent" shape must NOT
 * read through it.
 */
describe("the server modules compose the meeting caps (#525)", () => {
	const meetings = readSource(resolve(here(), "../server/meetings.ts"));
	const minutes = readSource(resolve(here(), "../server/minutes.ts"));

	// Keyed on the FIELD, so a new schema that adds `theme` with a bare
	// `z.string()` is caught rather than slipping past a per-name check.
	for (const field of ["theme", "location", "notes", "reminders"] as const) {
		it(`declares every ${field} from a capped validator`, () => {
			const declarations =
				meetings.match(
					new RegExp(
						`\\b${field}\\s*:\\s*(?:z|MEETING_FIELDS|MEETING_UPDATE_FIELDS)\\.[^,\\n]*`,
						"g",
					),
				) ?? [];
			// There must BE one — a guard that passes on zero matches goes green the
			// moment the field is renamed out from under it.
			expect(declarations.length).toBeGreaterThan(0);
			for (const d of declarations) {
				expect(d).toMatch(/MEETING_(?:UPDATE_)?FIELDS\./);
			}
		});
	}

	// The create/update split is a DECISION, not an accident, and it is the same
	// one `wod-limits` encodes for the same two schemas: create rejects so the
	// author sees an error on new input, update truncates so a row written before
	// the cap cannot lock an officer out of the whole edit form.
	it("rejects on create and truncates on update", () => {
		const createBlock = meetings.slice(
			meetings.indexOf("const createMeetingSchema"),
			meetings.indexOf("const updateMeetingSchema"),
		);
		const updateBlock = meetings.slice(
			meetings.indexOf("const updateMeetingSchema"),
			meetings.indexOf("const updateWordOfTheDaySchema"),
		);
		expect(createBlock).toMatch(/theme: MEETING_FIELDS\.theme/);
		expect(createBlock).not.toMatch(/theme: MEETING_UPDATE_FIELDS/);
		expect(updateBlock).toMatch(/theme: MEETING_UPDATE_FIELDS\.theme/);
		expect(updateBlock).not.toMatch(/theme: MEETING_FIELDS\.theme/);
	});

	// TRUNCATES, and the reason is the offline queue rather than a prefilled
	// form — see `MEETING_UPDATE_FIELDS`. Rejecting here would let one over-long
	// topic freeze every later minutes write for that meeting.
	it("truncates the Table Topics topic rather than rejecting it", () => {
		expect(minutes).toMatch(/topic: MEETING_UPDATE_FIELDS\.topic/);
		expect(minutes).not.toMatch(/topic: MEETING_FIELDS\.topic/);
	});

	/**
	 * The offender sweep, and the one that actually earns its place.
	 *
	 * The first version of this guard read ONLY `meetings.ts` and `minutes.ts`,
	 * and the adversarial pass found a live counterexample it could not see:
	 * `batch-meetings.ts` declared `location: z.string().trim().optional()` and
	 * wrote up to 52 rows per request. A per-file guard cannot prove a negative
	 * about files it never opens, so this sweeps every server module.
	 *
	 * Reads RAW, not comment-blind. This is the "offender list must be EMPTY"
	 * shape, where stripping comments can only DELETE text a match might have
	 * needed — it loosens the guard. `guard-source.ts` documents the split; the
	 * "must BE present" assertions above are the ones that read through it.
	 */
	it("leaves no meeting free-text field on a bare z.string() anywhere in src/server", () => {
		const dir = resolve(here(), "../server");
		const offenders: string[] = [];
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".ts") || file.includes(".test.")) continue;
			const raw = readFileSync(resolve(dir, file), "utf8");
			for (const field of REJECT_KEYS) {
				const m = raw.match(
					new RegExp(`\\b${field}\\s*:\\s*z\\.string\\(`, "g"),
				);
				if (m) offenders.push(`${file}: ${field} (${m.length})`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

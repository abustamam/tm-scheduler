/**
 * The `upsert_agendas` schemas, fed real inputs (#808).
 *
 * These objects sit behind a `validator(…)` and behind the MCP tool's own
 * `z.object(inputSchema).parse`, neither of which any test in this repo can
 * execute — #806 shipped a discriminated union with a duplicated discriminator
 * there and broke every edit on its confirm page with typecheck, lint and 7,600
 * tests green, because the throw lands on the first PARSE rather than on
 * construction. So the schemas are exported and parsed HERE, through the same
 * objects the runtime uses. A copy of the shapes in a test is the one thing
 * that could not have caught that.
 */
import { describe, expect, it } from "vitest";
import { MAX_BATCH } from "#/lib/meeting-recurrence";
import {
	agendaEntriesSchema,
	agendaEntrySchema,
	applySchema,
	localTime,
	parseAgendaPayload,
	pendingIdSchema,
} from "./agenda-plan-pending-schemas";

const DATE = "2026-10-06";

describe("agendaEntrySchema", () => {
	it("accepts a date alone", () => {
		expect(agendaEntrySchema.parse({ date: DATE })).toStrictEqual({
			date: DATE,
		});
	});

	it("keeps null distinct from absent", () => {
		// The tri-state has to survive the schema or the planner cannot tell
		// "leave the theme alone" from "clear it".
		const cleared = agendaEntrySchema.parse({ date: DATE, theme: null });
		expect(cleared.theme).toBeNull();
		const untouched = agendaEntrySchema.parse({ date: DATE });
		expect(untouched.theme).toBeUndefined();
		expect("theme" in untouched).toBe(false);
	});

	it("rejects a misspelled field rather than ignoring it", () => {
		// `.strict()`. An LLM writing snake_case would otherwise get a cheerful
		// plan showing no change at all.
		expect(() =>
			agendaEntrySchema.parse({ date: DATE, word_of_the_day: "ebullient" }),
		).toThrow();
	});

	it("rejects a date that is not club-local YYYY-MM-DD", () => {
		expect(() => agendaEntrySchema.parse({ date: "6 Oct 2026" })).toThrow();
		expect(() =>
			agendaEntrySchema.parse({ date: "2026-10-06T19:00:00Z" }),
		).toThrow();
	});

	it("rejects an over-long theme rather than truncating it", () => {
		// The create-path validators, which REJECT. An MCP call carries only what
		// the caller just said, so a rejection costs that one value and is
		// actionable — the lockout argument that drives truncation elsewhere is
		// about a form resubmitting a value stored before the cap existed.
		expect(() =>
			agendaEntrySchema.parse({ date: DATE, theme: "x".repeat(201) }),
		).toThrow();
	});

	it("rejects a scheduling field this tool does not own", () => {
		// Rescheduling is a different affordance with its own authorization
		// (ADR-0010) and is out of scope; `.strict()` is what says so.
		expect(() =>
			agendaEntrySchema.parse({ date: DATE, lengthMinutes: 90 }),
		).toThrow();
		expect(() =>
			agendaEntrySchema.parse({ date: DATE, notes: "internal" }),
		).toThrow();
		expect(() =>
			agendaEntrySchema.parse({ date: DATE, reminders: "emailed to members" }),
		).toThrow();
	});
});

describe("localTime", () => {
	it("takes a 24-hour club-local time", () => {
		expect(localTime.parse("19:00")).toBe("19:00");
		expect(localTime.parse("00:00")).toBe("00:00");
		expect(localTime.parse("23:59")).toBe("23:59");
	});

	it("refuses anything else", () => {
		for (const bad of ["7pm", "24:00", "19:60", "9:00", "19:00:00"]) {
			expect(() => localTime.parse(bad), bad).toThrow();
		}
	});
});

describe("agendaEntriesSchema", () => {
	it("needs at least one date and allows a club-year", () => {
		expect(() => agendaEntriesSchema.parse([])).toThrow();
		const year = Array.from({ length: MAX_BATCH }, (_, i) => ({
			date: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
		}));
		// Distinct by construction above only for the first 28×12; de-dupe to be
		// sure the cap, not the uniqueness rule, is what is being measured.
		const distinct = [...new Map(year.map((e) => [e.date, e])).values()];
		expect(agendaEntriesSchema.parse(distinct)).toHaveLength(distinct.length);
	});

	it("refuses more than MAX_BATCH", () => {
		const tooMany = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({
			date: `2026-01-${String(i + 1).padStart(2, "0")}`,
		}));
		expect(() => agendaEntriesSchema.parse(tooMany)).toThrow();
	});

	it("refuses the same date twice, naming both entries", () => {
		// A VALIDATION rejection rather than a blocking item: a mistake visible in
		// the call itself, needing no club state to see. Last-write-wins would
		// silently discard one of two instructions, which is what `DUPLICATE_SLOT`
		// refuses for `assign_roles`.
		const result = agendaEntriesSchema.safeParse([
			{ date: DATE, theme: "Harvest" },
			{ date: "2026-10-13" },
			{ date: DATE, theme: "Autumn" },
		]);
		expect(result.success).toBe(false);
		const message = result.success ? "" : result.error.issues[0]?.message;
		expect(message).toContain(DATE);
		expect(message).toContain("0");
		expect(message).toContain("2");
	});
});

describe("parseAgendaPayload — the deploy boundary", () => {
	it("reads a payload this release wrote", () => {
		const parsed = parseAgendaPayload({
			meetings: [{ date: DATE, theme: "Harvest" }],
		});
		expect(parsed?.entries).toStrictEqual([{ date: DATE, theme: "Harvest" }]);
		expect(parsed?.entriesUnreadable).toBe(false);
	});

	it("reads an applied tombstone as deliberately empty, not as corruption", () => {
		const parsed = parseAgendaPayload({
			meetings: null,
			applied: { created: 2, updated: 1, dates: [DATE] },
		});
		expect(parsed?.entries).toBeNull();
		expect(parsed?.entriesUnreadable).toBe(false);
		expect(parsed?.applied).toStrictEqual({
			created: 2,
			updated: 1,
			dates: [DATE],
		});
	});

	it("marks a shape it cannot read as unreadable, rather than guessing", () => {
		// A row written by the next release. `applyAgendaPlan` writes straight
		// into `meetings` with nothing validating in between, so the read boundary
		// has to refuse rather than write half of something it does not understand.
		const parsed = parseAgendaPayload({
			meetings: [{ when: DATE, headline: "Harvest" }],
		});
		expect(parsed?.entriesUnreadable).toBe(true);
		expect(parsed?.entries).toBeNull();
	});

	it("answers null for an envelope that is not an object at all", () => {
		expect(parseAgendaPayload(null)).toBeNull();
		expect(parseAgendaPayload("nope")).toBeNull();
		expect(parseAgendaPayload([{ date: DATE }])).toBeNull();
	});

	it("keeps a tombstone readable when its summary is not", () => {
		// The dates and the summary fail independently: a summary shape from a
		// release this one has never seen should not make an applied row read as
		// corrupt, because "applied" is still the true and useful thing to say.
		const parsed = parseAgendaPayload({ meetings: null, applied: "two" });
		expect(parsed?.entries).toBeNull();
		expect(parsed?.entriesUnreadable).toBe(false);
		expect(parsed?.applied).toBeNull();
	});
});

describe("the server-fn input schemas", () => {
	it("take a uuid and nothing else", () => {
		expect(() => pendingIdSchema.parse({ pendingId: "not-a-uuid" })).toThrow();
		expect(() =>
			applySchema.parse({
				pendingId: "3f8b1c9e-2d4a-4c6b-8e1f-5a7c9d0b2e34",
				planHash: "",
			}),
		).toThrow();
		expect(
			applySchema.parse({
				pendingId: "3f8b1c9e-2d4a-4c6b-8e1f-5a7c9d0b2e34",
				planHash: "abc",
			}).planHash,
		).toBe("abc");
	});
});

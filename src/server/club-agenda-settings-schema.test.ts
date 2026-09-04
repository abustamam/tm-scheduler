/**
 * `clubAgendaSettingsSchema`'s Table Topics bounds (#443) — the WRITE-side
 * validation layer.
 *
 * Deliberately NOT in `club-profile.integration.test.ts`. These are pure
 * `safeParse` assertions that touch no database, and that file's describe is
 * `skipIf(!hasTestDb)` — so on a plain `bun run test` with no
 * `TEST_DATABASE_URL` every one of them silently skipped while the pass count
 * still read green. CLAUDE.md names that exact trap, and the absolute ceiling
 * is precisely the assertion its relative-constant rule is about, so it is the
 * worst one to have hidden behind a skip.
 *
 * `clubs-logic.ts` imports `#/db`, which throws without `DATABASE_URL`, and
 * vitest's setup provides no such var. One might expect importing the schema to
 * be safe on the grounds that `db` is constructed lazily — it is not:
 * `src/db/index.ts` calls `drizzle(process.env.DATABASE_URL!)` at module scope,
 * so the throw happens on import. Hence this file mocks `#/db` the same way the
 * integration suites do, purely to make the import side-effect free. No query is
 * ever issued.
 */
import { describe, expect, it, vi } from "vitest";
import { TABLE_TOPICS_MESSAGES } from "#/lib/table-topics-limits";

vi.mock("#/db", () => ({ db: {} }));

const { clubAgendaSettingsSchema } = await import("./clubs-logic");

const base = {
	// A real v4 uuid: zod 4 validates the version nibble, so an all-zeros
	// placeholder fails `.uuid()` and would make every case below fail for a
	// reason unrelated to the bounds under test.
	clubId: "11111111-1111-4111-8111-111111111111",
	geIntroducesFunctionaries: false,
};
const result = (min: number | null, max: number | null) =>
	clubAgendaSettingsSchema.safeParse({
		...base,
		tableTopicsMinSeconds: min,
		tableTopicsMaxSeconds: max,
	});
const parse = (min: number | null, max: number | null) =>
	result(min, max).success;
/** The first issue's message and the field it points at. */
const refusal = (min: number | null, max: number | null) => {
	const r = result(min, max);
	if (r.success) return null;
	const issue = r.error.issues[0];
	return { message: issue.message, path: issue.path.join(".") };
};

describe("clubAgendaSettingsSchema table topics bounds (#443)", () => {
	it("enforces an ABSOLUTE ceiling of 600 seconds", () => {
		// Both sides of the boundary, as literals. `<= MAX_TABLE_TOPICS_SECONDS`
		// would pass for every value of the constant, including one that
		// reintroduces the problem.
		expect(parse(60, 599)).toBe(true);
		expect(parse(60, 600)).toBe(true);
		expect(parse(60, 601)).toBe(false);
	});

	it("rejects a fractional second", () => {
		// A fraction reaching the clock formatter is where "2:30" becomes "2:29"
		// on one surface and "2:30" on another.
		expect(parse(60, 150.5)).toBe(false);
		expect(parse(60.5, 150)).toBe(false);
	});

	it("rejects a half-stated window", () => {
		// Stored silently, it would read back as "not stated" and the admin would
		// watch their own entry disappear with no error.
		expect(parse(60, null)).toBe(false);
		expect(parse(null, 150)).toBe(false);
	});

	it("rejects an inverted or equal window", () => {
		expect(parse(150, 60)).toBe(false);
		expect(parse(90, 90)).toBe(false);
	});

	it("rejects a NEGATIVE bound, which only `.min(0)` on the shape catches", () => {
		// `refuseTableTopicsSeconds` deliberately does not check negatives — the
		// form's parser cannot emit one — so `.min(0)` is the only server-side
		// refusal, and #679 edited the line it sits on. Without this pair,
		// deleting `.min(0)` stores a negative minimum through the server fn with
		// the whole suite green: the DB CHECK also covers it, but that suite
		// silently SKIPS with no `TEST_DATABASE_URL`, so the cheap assertion
		// belongs here. ABSOLUTE, both sides of the boundary.
		expect(parse(-1, 150)).toBe(false);
		expect(parse(0, 150)).toBe(true);
	});

	it("accepts MCF's window and the cleared state", () => {
		// The half that fails if someone "fixes" the above by rejecting
		// everything — without it every assertion here passes vacuously.
		expect(parse(60, 150)).toBe(true);
		expect(parse(null, null)).toBe(true);
	});

	// #679 — the three rules above are now ONE statement
	// (`refuseTableTopicsSeconds`) shared with the admin form, so the schema and
	// the form refuse an input with the same sentence rather than merely with the
	// same vocabulary. These assert what the shared predicate produces HERE: the
	// message, and the field it lands on.
	describe("speaks with the form's voice, on the form's field", () => {
		it("gives the ceiling refusal its own sentence, not a raw zod .max()", () => {
			// It used to be `.max(600)` on the bound, whose message is zod's own
			// ("Too big: expected number to be <=600") — which is what the admin saw
			// when the form's missing ceiling check let 20:00 through.
			expect(refusal(60, 601)).toEqual({
				message: TABLE_TOPICS_MESSAGES.tooLong,
				path: "tableTopicsMaxSeconds",
			});
			// A minimum over the ceiling points at the MINIMUM. Under the old
			// per-bound `.max()` this was also true; the shared predicate has to keep
			// it, because reporting a maximum problem for a minimum typo sends the
			// admin to the wrong input.
			expect(refusal(601, 700)).toEqual({
				message: TABLE_TOPICS_MESSAGES.tooLong,
				path: "tableTopicsMinSeconds",
			});
		});

		it("points a half-stated window at the BLANK field", () => {
			expect(refusal(60, null)).toEqual({
				message: TABLE_TOPICS_MESSAGES.halfStated,
				path: "tableTopicsMaxSeconds",
			});
			expect(refusal(null, 150)).toEqual({
				message: TABLE_TOPICS_MESSAGES.halfStated,
				path: "tableTopicsMinSeconds",
			});
		});

		it("points an inverted window at the maximum", () => {
			expect(refusal(150, 60)).toEqual({
				message: TABLE_TOPICS_MESSAGES.inverted,
				path: "tableTopicsMaxSeconds",
			});
		});

		it("still refuses a fraction, which is the SHAPE rule and not a rule of ours", () => {
			// Left on the bound deliberately: `refuseTableTopicsSeconds` is about the
			// three rules a person can get wrong on the form, and the form's parser
			// cannot emit a fraction. So this one keeps zod's own message — asserted
			// here so removing `.int()` cannot pass by falling through to a rule that
			// does not check it.
			expect(refusal(60.5, 150)?.path).toBe("tableTopicsMinSeconds");
			expect(refusal(60.5, 150)?.message).not.toBe(
				TABLE_TOPICS_MESSAGES.tooLong,
			);
		});
	});
});

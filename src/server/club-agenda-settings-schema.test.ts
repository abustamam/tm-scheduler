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
 * `clubs-logic.ts` imports `#/db`, which throws without `DATABASE_URL` — but
 * only when the module is EVALUATED, and vitest's setup provides no such var.
 * Importing the schema is safe because `db` is constructed lazily at module
 * scope from `process.env.DATABASE_URL`… which it is not. So this file mocks
 * `#/db` the same way the integration suites do, purely to make the import
 * side-effect free. No query is ever issued.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

const { clubAgendaSettingsSchema } = await import("./clubs-logic");

const base = {
	// A real v4 uuid: zod 4 validates the version nibble, so an all-zeros
	// placeholder fails `.uuid()` and would make every case below fail for a
	// reason unrelated to the bounds under test.
	clubId: "11111111-1111-4111-8111-111111111111",
	geIntroducesFunctionaries: false,
};
const parse = (min: number | null, max: number | null) =>
	clubAgendaSettingsSchema.safeParse({
		...base,
		tableTopicsMinSeconds: min,
		tableTopicsMaxSeconds: max,
	}).success;

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

	it("accepts MCF's window and the cleared state", () => {
		// The half that fails if someone "fixes" the above by rejecting
		// everything — without it every assertion here passes vacuously.
		expect(parse(60, 150)).toBe(true);
		expect(parse(null, null)).toBe(true);
	});
});

/**
 * Counting the SQL a loader actually issues.
 *
 * ## Why this exists
 *
 * Some invariants have no surface in a returned payload. "This loader reads the
 * `clubs` row once, not twice" produces a byte-identical result either way, so
 * an assertion about the result cannot fail — the same shape CLAUDE.md records
 * for empty-list guards ("assert the observable the guard actually controls").
 * For a redundant query the observable is the QUERY.
 *
 * ## Why it spies on the pg client, not on a named loader
 *
 * The obvious version — `vi.spyOn` a `loadClubX` function and count calls —
 * goes green the moment someone INLINES that query, which is exactly the change
 * these tests are written around. `season-grid-cc-query.integration.test.ts`
 * previously asserted `loadClubDefaultCountryCode` was not called; folding the
 * column into an existing `findFirst` deleted the call and left a test that
 * could only pass. Counting at the driver is indifferent to how the statement
 * was built — `db.query.x.findFirst`, `db.select().from(x)`, or raw SQL — so it
 * survives the refactors it is meant to police.
 *
 * `db.$client` is the node-postgres Pool underneath drizzle, and drizzle calls
 * it as `query({ text, values })`. The string form is handled too, since
 * `db.execute("select 1")` takes that path.
 *
 * ## What it CANNOT see: anything inside a transaction
 *
 * The spy is on the POOL. `db.transaction()` checks a `PoolClient` out of the
 * pool and issues every statement in the block — `BEGIN`, the body, `COMMIT` —
 * on that client, whose `query` is a different function object the spy never
 * wrapped. So a transactional loader reports ZERO statements here, and a "reads
 * `clubs` exactly once" assertion written against one would pass whether it read
 * the row once, twice or not at all.
 *
 * No caller is affected today: every test using this counts statements from
 * read-only loaders, which drizzle issues straight on the pool. It is recorded
 * because the failure is silent and reads exactly like success — which is the
 * same shape as the empty-`readsOf` case the note below already warns about, and
 * the reason that note says to assert non-emptiness before trusting a count.
 * A transaction-aware version would have to spy on `Pool.connect` as well and
 * fold in each client it hands out.
 */
import { vi } from "vitest";
import { testDb } from "./db";

/** Every SQL statement the pg client is asked to run while `fn` runs. */
export async function statementsDuring(
	fn: () => Promise<unknown>,
): Promise<string[]> {
	// biome-ignore lint/suspicious/noExplicitAny: the pg Pool is not typed on the drizzle handle
	const client = testDb.$client as any;
	const spy = vi.spyOn(client, "query");
	try {
		await fn();
		return spy.mock.calls.map((call) => {
			const arg = call[0] as string | { text?: string } | undefined;
			if (typeof arg === "string") return arg;
			return arg?.text ?? "";
		});
	} finally {
		spy.mockRestore();
	}
}

/**
 * The subset of `statements` that read `table`.
 *
 * Matches `from "table"` — the quoted form drizzle emits — so a table whose name
 * is a substring of another (`club` vs `clubs`) does not cross-match. Callers
 * should assert the result is non-empty before trusting a count: a dialect or
 * driver change that broke this pattern would report zero reads and make every
 * "no extra query" assertion pass vacuously.
 */
export function readsOf(statements: string[], table: string): string[] {
	const pattern = new RegExp(`\\bfrom\\s+"${table}"`, "i");
	return statements.filter((sql) => pattern.test(sql));
}

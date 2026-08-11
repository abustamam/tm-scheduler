/**
 * Pins that the season grid reads the `clubs` row ONCE, on every path. Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/season-grid-cc-query.integration.test.ts
 *
 * ## Why a whole file for this
 *
 * The invariant has no surface in the returned payload: whether the loader made
 * one `clubs` query or two, the grid it returns is byte-identical. So the
 * observable has to be the QUERIES, not the result — CLAUDE.md, "an empty-list
 * guard is invisible to a result assertion". The public grid is served
 * unauthenticated, so a wasted round trip there is a cost anyone can impose.
 *
 * ## What changed, and why this file was rewritten rather than deleted
 *
 * It used to spy on `loadClubDefaultCountryCode` and assert it was NOT CALLED on
 * the public path — because the contact path loaded the country code with a
 * SECOND, serialized query and an `if (input.includeContact)` gate kept the
 * public path out of it.
 *
 * `defaultCountryCode` now rides along on the `clubs` row the loader already
 * fetches at the top, so there is no second call for anyone to skip and that
 * assertion could only ever pass. The INVARIANT is unchanged and still worth
 * pinning — arguably more so, since the gate that used to enforce it is gone —
 * but the mechanism it reads has to change from "the function is not called" to
 * "no extra query is issued". Rewriting it as a call-count on a function nobody
 * calls would have been a tautology wearing the old test's name.
 *
 * Counting at the pg client is deliberate: it is the one place that cannot be
 * fooled by HOW the row is fetched. A spy on a named loader goes green the
 * moment someone inlines the query, which is exactly the change that just
 * happened here. The spy itself lives in `#/test/query-spy` — the guest
 * pipeline needed the same one.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, hasTestDb, type SeededClub, seedClub } from "#/test/db";
import { readsOf, statementsDuring } from "#/test/query-spy";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const clubReads = (statements: string[]) => readsOf(statements, "clubs");

describe.skipIf(!hasTestDb)("season grid clubs-row reads", () => {
	it("reads the clubs row once, with or without the contact flag", async () => {
		// THE assertion. The country code is a column on the row `loadSeasonGrid`
		// already fetches, so turning contact ON must not change how many times
		// that row is read. The previous implementation failed this: it awaited
		// `loadClubDefaultCountryCode` inside the `includeContact` branch, making
		// the contact path two serialized round trips to one row.
		const seed: SeededClub = await seedClub();
		try {
			const { loadSeasonGrid } = await import("#/server/season-grid-logic");

			const withoutContact = clubReads(
				await statementsDuring(() =>
					loadSeasonGrid({ clubId: seed.clubId, count: 8 }),
				),
			);
			const withContact = clubReads(
				await statementsDuring(() =>
					loadSeasonGrid({
						clubId: seed.clubId,
						count: 8,
						includeContact: true,
					}),
				),
			);

			// Anti-vacuity FIRST: a spy that intercepted nothing, or a `from
			// "clubs"` pattern that stopped matching after a driver or dialect
			// change, would report 0 reads and make every assertion below pass for
			// the wrong reason — the same hole the old file's positive case covered.
			expect(
				withoutContact.length,
				"no `clubs` read was observed at all — the query spy or the SQL " +
					"pattern has stopped working, so this file tests nothing",
			).toBeGreaterThan(0);

			expect(withoutContact).toHaveLength(1);
			expect(
				withContact,
				"the contact path issued an EXTRA `clubs` read. `defaultCountryCode` " +
					"rides along on the row the loader already fetches at the top — " +
					"see season-grid-logic.ts. A second query is a serialized round " +
					"trip for a column that was already in hand.",
			).toHaveLength(1);

			// Stated as an equality too, so the intent survives a future change to
			// how many reads one load legitimately makes: whatever that number is,
			// contact must not add to it.
			expect(withContact.length).toBe(withoutContact.length);

			// And the row that IS read carries the column, so "one read" was not
			// achieved by dropping the country code and silently regressing #295.
			expect(withContact[0]).toContain("default_country_code");
		} finally {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		}
	});

	it("adds no clubs read to the unauthenticated public path", async () => {
		// The public sheet reads `clubs` TWICE, and both are legitimate: the
		// archived-club readability gate (`isReadableClub`, #544) probes
		// `archived_at`, then the grid fetches its own row. Neither is the country
		// code, and that is unchanged by the column moving onto the grid's row.
		//
		// Pinned as an exact list rather than a bare count, because a count alone
		// cannot tell "the gate plus the grid row" from "the grid row plus a
		// reintroduced country-code query" — the regression this file exists for.
		const seed: SeededClub = await seedClub();
		try {
			const { loadPublicSeasonGrid } = await import(
				"#/server/season-grid-logic"
			);
			const reads = clubReads(
				await statementsDuring(() =>
					loadPublicSeasonGrid({ clubId: seed.clubId, count: 8 }),
				),
			);

			expect(reads).toHaveLength(2);
			expect(reads[0], "expected the archived-club readability gate").toContain(
				"archived_at",
			);
			expect(reads[1], "expected the grid's own clubs row").toContain(
				"timezone",
			);
			// The country code arrives on the grid's row, never as a third query.
			expect(
				reads.filter((sql) => sql.includes("default_country_code")),
				"the country code must not cost the public path its own query",
			).toHaveLength(1);
		} finally {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		}
	});

	it("still keeps contact off the public payload", async () => {
		// The other half of the original invariant, and the one that actually
		// protects PII. Cheap to state here, and it stops the file from being
		// purely about query counts — a version that made one query and leaked
		// email would satisfy everything above.
		const seed: SeededClub = await seedClub();
		try {
			const { loadPublicSeasonGrid } = await import(
				"#/server/season-grid-logic"
			);
			const grid = await loadPublicSeasonGrid({
				clubId: seed.clubId,
				count: 8,
			});
			expect(grid.members.length).toBeGreaterThan(0);
			for (const m of grid.members) {
				expect(m).not.toHaveProperty("email");
				expect(m).not.toHaveProperty("phone");
			}
		} finally {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		}
	});
});

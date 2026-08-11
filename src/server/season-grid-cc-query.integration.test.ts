/**
 * Pins that the season grid loads the club default country code ONLY on the
 * contact path. Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/season-grid-cc-query.integration.test.ts
 *
 * Why a whole file for one assertion: the guard's only effect is AVOIDING WORK,
 * which is invisible to any assertion about the returned payload. Deleting the
 * `if (input.includeContact)` gate and awaiting `loadClubDefaultCountryCode`
 * unconditionally leaves every other season-grid test green — the public grid
 * would simply pay for a round-trip it is forbidden to use, on an
 * unauthenticated endpoint. So the observable has to be the CALL, not the
 * result. See CLAUDE.md, "an empty-list guard is invisible to a result
 * assertion".
 *
 * Lives apart from `season-grid.integration.test.ts` because `vi.mock` is
 * module-scoped: mocking `clubs-logic` for the whole of that file would make
 * every other test in it run against a wrapped implementation.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, hasTestDb, type SeededClub, seedClub } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Hoisted so the `vi.mock` factory below (which vitest lifts above the imports)
// can close over it.
const { ccSpy } = vi.hoisted(() => ({ ccSpy: vi.fn() }));

// Delegates to the REAL implementation — this counts calls, it does not stub
// behavior, so the grid under test still gets a genuine country code.
vi.mock("#/server/clubs-logic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/server/clubs-logic")>();
	return {
		...actual,
		loadClubDefaultCountryCode: (clubId: string) => {
			ccSpy(clubId);
			return actual.loadClubDefaultCountryCode(clubId);
		},
	};
});

describe.skipIf(!hasTestDb)("season grid country-code query", () => {
	it("runs only on the contact path", async () => {
		const seed: SeededClub = await seedClub();
		try {
			const { loadPublicSeasonGrid, loadSeasonGrid } = await import(
				"#/server/season-grid-logic"
			);

			// The public, unauthenticated sheet: no contact in the payload, so no
			// query for the country code that would normalize it.
			ccSpy.mockClear();
			await loadPublicSeasonGrid({ clubId: seed.clubId, count: 8 });
			expect(ccSpy).not.toHaveBeenCalled();

			// Same via the shared loader with the flag simply absent.
			ccSpy.mockClear();
			await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
			expect(ccSpy).not.toHaveBeenCalled();

			// The positive case is what makes the two above meaningful: it proves
			// the spy is genuinely wired rather than silently inert. Without it,
			// a mock that never intercepted anything would report zero calls and
			// both assertions would pass vacuously.
			ccSpy.mockClear();
			await loadSeasonGrid({
				clubId: seed.clubId,
				count: 8,
				includeContact: true,
			});
			expect(ccSpy).toHaveBeenCalledTimes(1);
			expect(ccSpy).toHaveBeenCalledWith(seed.clubId);
		} finally {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		}
	});
});

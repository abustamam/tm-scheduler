/**
 * DB-backed tests for resolveClubByIdentifier. `#/db` is redirected to the
 * test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/clubs.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { resolveClubByIdentifier } from "./clubs-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("resolveClubByIdentifier", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		await testDb
			.update(clubs)
			.set({ slug: `mcf-${seed.clubId}`, clubNumber: `num-${seed.clubId}` })
			.where(eq(clubs.id, seed.clubId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("resolves by slug", async () => {
		const club = await resolveClubByIdentifier(`mcf-${seed.clubId}`);
		expect(club.id).toBe(seed.clubId);
	});
	it("resolves by club number", async () => {
		const club = await resolveClubByIdentifier(`num-${seed.clubId}`);
		expect(club.id).toBe(seed.clubId);
	});
	it("resolves by UUID", async () => {
		const club = await resolveClubByIdentifier(seed.clubId);
		expect(club.slug).toBe(`mcf-${seed.clubId}`);
	});
	it("matches slug case-insensitively", async () => {
		const club = await resolveClubByIdentifier(
			`MCF-${seed.clubId}`.toUpperCase(),
		);
		expect(club.id).toBe(seed.clubId);
	});
	it("throws for an unknown identifier", async () => {
		await expect(
			resolveClubByIdentifier("nope-does-not-exist"),
		).rejects.toThrow();
	});
});

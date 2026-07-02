/**
 * DB-backed tests for resolveClubByIdentifier. `#/db` is redirected to the
 * test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/clubs.integration.test.ts
 */
import { randomUUID } from "node:crypto";
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
	// Extra bare clubs (no seedClub children) some tests insert; cleaned up below.
	let extraClubIds: string[] = [];

	beforeEach(async () => {
		extraClubIds = [];
		seed = await seedClub();
		await testDb
			.update(clubs)
			.set({ slug: `mcf-${seed.clubId}`, clubNumber: `num-${seed.clubId}` })
			.where(eq(clubs.id, seed.clubId));
	});
	afterEach(async () => {
		for (const id of extraClubIds) {
			await testDb.delete(clubs).where(eq(clubs.id, id));
		}
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("resolves by slug", async () => {
		const club = await resolveClubByIdentifier(`mcf-${seed.clubId}`);
		expect(club?.id).toBe(seed.clubId);
	});
	it("resolves by club number", async () => {
		const club = await resolveClubByIdentifier(`num-${seed.clubId}`);
		expect(club?.id).toBe(seed.clubId);
	});
	it("resolves by UUID", async () => {
		const club = await resolveClubByIdentifier(seed.clubId);
		expect(club?.slug).toBe(`mcf-${seed.clubId}`);
	});
	it("matches slug case-insensitively", async () => {
		const club = await resolveClubByIdentifier(
			`MCF-${seed.clubId}`.toUpperCase(),
		);
		expect(club?.id).toBe(seed.clubId);
	});
	it("prefers the slug owner when another club's number collides", async () => {
		// Club B's club_number equals club A's (seed's) slug. Resolving that
		// value matches A by slug AND B by number — the slug owner (A) must win.
		const collide = `mcf-${seed.clubId}`;
		const otherClubId = randomUUID();
		extraClubIds.push(otherClubId);
		await testDb.insert(clubs).values({
			id: otherClubId,
			name: "Number Collider",
			slug: `other-${otherClubId}`,
			clubNumber: collide,
		});

		const club = await resolveClubByIdentifier(collide);
		expect(club?.id).toBe(seed.clubId);
	});
	it("returns null for an unknown identifier", async () => {
		await expect(
			resolveClubByIdentifier("nope-does-not-exist"),
		).resolves.toBeNull();
	});
});

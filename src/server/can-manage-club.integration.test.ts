/**
 * `canManageClub` against a real database: the READ-surface flag that drives the
 * meeting page's `canManage` and the season grid's `isAdmin`. It shares the
 * officer arm of `requireClubRole(…, ["admin"])` (effective admin, #202): a
 * stored admin OR an active membership holding an OPEN officer term.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, officerTerms } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { canManageClub } = await import("#/server/guards");

describe.skipIf(!hasTestDb)("canManageClub officer arm", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const seat = (termEnd: Date | null) =>
		testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "vp_education",
			termStart: new Date(Date.now() - 86_400_000),
			termEnd,
		});

	it("admits a stored admin", async () => {
		expect(await canManageClub(seed.adminUserId, seed.clubId)).toBe(true);
	});

	it("refuses a plain member with no officer term", async () => {
		expect(await canManageClub(seed.memberUserId, seed.clubId)).toBe(false);
	});

	it("admits a member holding an open officer term", async () => {
		await seat(null);
		expect(await canManageClub(seed.memberUserId, seed.clubId)).toBe(true);
	});

	it("refuses a member whose officer term has ended", async () => {
		await seat(new Date(Date.now() - 3_600_000));
		expect(await canManageClub(seed.memberUserId, seed.clubId)).toBe(false);
	});

	it("refuses an officer whose membership is not active", async () => {
		await seat(null);
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.memberId));
		expect(await canManageClub(seed.memberUserId, seed.clubId)).toBe(false);
	});
});

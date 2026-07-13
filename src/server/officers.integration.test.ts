/**
 * DB-backed integration tests for getOpenOfficerPositions (#202) — the officer
 * lookup behind effective-admin and the officer home.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { officerTerms } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { getOpenOfficerPositions } from "./officers-logic";

describe.skipIf(!hasTestDb)("getOpenOfficerPositions (#202)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("returns open offices and ignores closed (term_end set) ones", async () => {
		await testDb.insert(officerTerms).values([
			{ membershipId: seed.memberId, position: "secretary" },
			{
				membershipId: seed.memberId,
				position: "treasurer",
				termEnd: new Date(),
			},
		]);
		const open = await getOpenOfficerPositions(testDb, seed.memberId);
		expect(open).toEqual(["secretary"]);
	});

	it("is empty when the member holds no office", async () => {
		expect(await getOpenOfficerPositions(testDb, seed.memberId)).toEqual([]);
	});
});

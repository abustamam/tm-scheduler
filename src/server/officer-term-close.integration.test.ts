/**
 * DB-backed tests for `closeOpenOfficerTerms` (#805) — the write that REVOKES
 * effective-admin, beside `officers.integration.test.ts` which covers the read
 * that confers it.
 *
 * It is tested at this level rather than only through convert because what it
 * has to get right is a WHERE clause and a return value, and both are invisible
 * from the caller: convert asserts "the President's term ended", which passes
 * just as happily on a statement that closed every officer term in the
 * database. The cases below are the ones that tell those apart — a closed term
 * left alone, another membership's terms left alone, and the returned list
 * being exactly what was written.
 *
 * `officer_terms` has no club column; it reaches a club only through
 * `members.club_id`. That is precisely why the "leaves another membership
 * alone" case matters: there is no club scope in this query to save a
 * membership-id predicate that is wrong.
 */
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { officerTerms } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import {
	closeOpenOfficerTerms,
	getOpenOfficerPositions,
} from "./officers-logic";

describe.skipIf(!hasTestDb)("closeOpenOfficerTerms (#805)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/** Every term row on a membership, oldest position first, so a case can see
	 *  what survived as well as what changed. */
	function termsOf(membershipId: string) {
		return testDb
			.select({
				position: officerTerms.position,
				termEnd: officerTerms.termEnd,
			})
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, membershipId))
			.orderBy(asc(officerTerms.position));
	}

	it("closes every open term and returns them in canonical rank order", async () => {
		// The fixture is chosen so canonical order disagrees with BOTH of the
		// orders a broken implementation would produce. `secretary` ranks 4 and
		// `vp_education` ranks 1, so the answer is VP Education first — while
		// insertion order says Secretary first (no sort at all) and so does a
		// bare `.sort()` with no comparator, since "secretary" < "vp_education"
		// as strings. A President/Treasurer pair agrees with both and would pin
		// the direction while leaving the KEY untested.
		await testDb.insert(officerTerms).values([
			{ membershipId: seed.memberId, position: "secretary" },
			{ membershipId: seed.memberId, position: "vp_education" },
		]);

		expect(await closeOpenOfficerTerms(testDb, seed.memberId)).toEqual([
			"vp_education",
			"secretary",
		]);
		// The grant is gone, asserted through the seam that confers it rather
		// than by re-reading the column: these two functions disagreeing is the
		// only way this write can look done and not be.
		expect(await getOpenOfficerPositions(testDb, seed.memberId)).toEqual([]);
	});

	it("leaves an already-closed term exactly as it was", async () => {
		// Retaining the real end date is the point (#100): a closed term is the
		// club's officer history, and re-stamping `term_end` on every close would
		// quietly rewrite when a past President actually served.
		const servedUntil = new Date("2021-06-30T00:00:00.000Z");
		await testDb.insert(officerTerms).values([
			{ membershipId: seed.memberId, position: "secretary" },
			{
				membershipId: seed.memberId,
				position: "treasurer",
				termEnd: servedUntil,
			},
		]);

		expect(await closeOpenOfficerTerms(testDb, seed.memberId)).toEqual([
			"secretary",
		]);
		const rows = await termsOf(seed.memberId);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.termEnd).toBeInstanceOf(Date);
		expect(rows[1]?.termEnd?.toISOString()).toBe(servedUntil.toISOString());
	});

	it("touches no other membership's terms", async () => {
		await testDb.insert(officerTerms).values([
			{ membershipId: seed.memberId, position: "secretary" },
			{ membershipId: seed.adminMemberId, position: "president" },
		]);

		await closeOpenOfficerTerms(testDb, seed.memberId);

		expect(await getOpenOfficerPositions(testDb, seed.adminMemberId)).toEqual([
			"president",
		]);
	});

	it("is a no-op returning [] when the membership holds no open office", async () => {
		// Empty must mean "there was nothing open", not "the statement did not
		// run" — the caller shows a sentence when this is non-empty and stays
		// silent when it is not, so the two cases are a user-visible difference.
		await testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "president",
			termEnd: new Date("2022-06-30T00:00:00.000Z"),
		});

		expect(await closeOpenOfficerTerms(testDb, seed.memberId)).toEqual([]);
		expect(await termsOf(seed.memberId)).toHaveLength(1);
	});
});

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

	it("closes every open term and returns them President first", async () => {
		// Canonical order, not insertion order: the caller reads this list into a
		// toast, and Postgres returns updated rows in no defined order — so
		// inserting Treasurer first is the arrangement that catches a missing
		// sort rather than agreeing with one.
		await testDb.insert(officerTerms).values([
			{ membershipId: seed.memberId, position: "treasurer" },
			{ membershipId: seed.memberId, position: "president" },
		]);

		expect(await closeOpenOfficerTerms(testDb, seed.memberId)).toEqual([
			"president",
			"treasurer",
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

	it("stamps the end date the caller passes, not its own clock", async () => {
		// Convert closes the term inside the same transaction that wakes the
		// membership, and a caller that needs those two to carry one timestamp
		// has to be able to say so. Pinned because the parameter has a default,
		// which is exactly the shape that gets silently ignored.
		const closedAt = new Date("2023-03-04T05:06:07.000Z");
		await testDb
			.insert(officerTerms)
			.values({ membershipId: seed.memberId, position: "president" });

		await closeOpenOfficerTerms(testDb, seed.memberId, closedAt);

		const rows = await termsOf(seed.memberId);
		expect(rows[0]?.termEnd?.toISOString()).toBe(closedAt.toISOString());
	});
});

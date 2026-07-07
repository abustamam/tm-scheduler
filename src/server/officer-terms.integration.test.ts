/**
 * DB-backed tests for officer terms (#100): the migration's open-ended-term
 * shape, multiple concurrent offices on one membership, deriving current
 * office(s) from open terms, closing a term, and history retention. Tests the
 * plain logic fns directly; `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/officer-terms.integration.test.ts
 */
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, officerTerms } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** Insert an extra roster membership in the seeded club (with its own person). */
async function addMembership(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	if (!m) throw new Error("Failed to insert membership");
	return m.id;
}

describe.skipIf(!hasTestDb)("officer terms (#100)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("migration shape: an open-ended term (term_end NULL) is the current office", async () => {
		const { currentOfficersFor, currentOfficersByMember } = await import(
			"#/server/officer-terms-logic"
		);
		// Exactly what the 0011 backfill inserts for a legacy officer_position:
		// term_start now(), term_end NULL.
		await testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "president",
			termStart: new Date(),
			termEnd: null,
		});
		expect(await currentOfficersFor(seed.memberId)).toEqual(["president"]);
		const map = await currentOfficersByMember([seed.memberId]);
		expect(map.get(seed.memberId)).toEqual(["president"]);
	});

	it("a membership can hold multiple concurrent offices, in canonical order", async () => {
		const { reconcileOfficerTerms, currentOfficersFor } = await import(
			"#/server/officer-terms-logic"
		);
		// Passed out of rank order — derivation returns them President-first.
		await reconcileOfficerTerms(testDb, seed.memberId, [
			"treasurer",
			"secretary",
		]);
		expect(await currentOfficersFor(seed.memberId)).toEqual([
			"secretary",
			"treasurer",
		]);
		const open = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId));
		expect(open).toHaveLength(2);
		expect(open.every((t) => t.termEnd === null)).toBe(true);
	});

	it("closing a term drops it from current but retains it as history", async () => {
		const { reconcileOfficerTerms, currentOfficersFor } = await import(
			"#/server/officer-terms-logic"
		);
		await reconcileOfficerTerms(testDb, seed.memberId, ["president"]);
		const { closed } = await reconcileOfficerTerms(testDb, seed.memberId, []);
		expect(closed).toEqual(["president"]);
		// No longer a current office.
		expect(await currentOfficersFor(seed.memberId)).toEqual([]);
		// But the row survives with term_end set (history is queryable).
		const all = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId));
		expect(all).toHaveLength(1);
		expect(all[0].position).toBe("president");
		expect(all[0].termEnd).not.toBeNull();
	});

	it("reconcile is additive/subtractive and leaves untouched terms alone", async () => {
		const { reconcileOfficerTerms } = await import(
			"#/server/officer-terms-logic"
		);
		await reconcileOfficerTerms(testDb, seed.memberId, ["secretary"]);
		const [secretaryTerm] = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId));
		// Add treasurer without disturbing the open secretary term.
		const res = await reconcileOfficerTerms(testDb, seed.memberId, [
			"secretary",
			"treasurer",
		]);
		expect(res.added).toEqual(["treasurer"]);
		expect(res.closed).toEqual([]);
		const open = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId));
		const sameSecretary = open.find((t) => t.id === secretaryTerm.id);
		expect(sameSecretary?.termEnd).toBeNull();
		expect(open.filter((t) => t.termEnd === null)).toHaveLength(2);
	});

	it("history retention: re-holding an office keeps the prior stint", async () => {
		const { reconcileOfficerTerms, currentOfficersFor } = await import(
			"#/server/officer-terms-logic"
		);
		await reconcileOfficerTerms(testDb, seed.memberId, ["president"]); // stint 1
		await reconcileOfficerTerms(testDb, seed.memberId, []); // closed
		await reconcileOfficerTerms(testDb, seed.memberId, ["president"]); // stint 2
		expect(await currentOfficersFor(seed.memberId)).toEqual(["president"]);
		const presidentTerms = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId))
			.orderBy(desc(officerTerms.createdAt));
		expect(presidentTerms).toHaveLength(2);
		expect(presidentTerms.filter((t) => t.termEnd === null)).toHaveLength(1);
		expect(presidentTerms.filter((t) => t.termEnd !== null)).toHaveLength(1);
	});

	it("openOfficerTermIfAbsent is idempotent per open position", async () => {
		const { openOfficerTermIfAbsent } = await import(
			"#/server/officer-terms-logic"
		);
		const first = await openOfficerTermIfAbsent(
			testDb,
			seed.memberId,
			"secretary",
			null,
		);
		const second = await openOfficerTermIfAbsent(
			testDb,
			seed.memberId,
			"secretary",
			null,
		);
		expect(first).toBe(true);
		expect(second).toBe(false);
		const open = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId));
		expect(open).toHaveLength(1);
	});

	it("currentOfficersForClub lists the full agenda line-up (vacant = null, no IPP), one per office, excluding inactive", async () => {
		const { reconcileOfficerTerms, currentOfficersForClub } = await import(
			"#/server/officer-terms-logic"
		);
		const zara = await addMembership(seed.clubId, "Zara Zephyr");
		const abe = await addMembership(seed.clubId, "Abe Anchor");
		// Zara holds two offices at once; Abe holds one. Nobody is IPP.
		await reconcileOfficerTerms(testDb, zara, ["secretary", "treasurer"]);
		await reconcileOfficerTerms(testDb, abe, ["president"]);
		let officers = await currentOfficersForClub(seed.clubId);
		// Every agenda office is present in canonical order; vacancies are null and
		// Immediate Past President never appears.
		expect(officers).toEqual([
			{ position: "president", name: "Abe Anchor" },
			{ position: "vp_education", name: null },
			{ position: "vp_membership", name: null },
			{ position: "vp_public_relations", name: null },
			{ position: "secretary", name: "Zara Zephyr" },
			{ position: "treasurer", name: "Zara Zephyr" },
			{ position: "sergeant_at_arms", name: null },
		]);
		// Inactive members drop out — their offices read as vacant.
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, zara));
		officers = await currentOfficersForClub(seed.clubId);
		expect(officers).toEqual([
			{ position: "president", name: "Abe Anchor" },
			{ position: "vp_education", name: null },
			{ position: "vp_membership", name: null },
			{ position: "vp_public_relations", name: null },
			{ position: "secretary", name: null },
			{ position: "treasurer", name: null },
			{ position: "sergeant_at_arms", name: null },
		]);
	});
});

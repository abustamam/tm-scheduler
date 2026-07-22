/**
 * DB-backed integration tests for the superadmin duplicate-detection read
 * layer added to `people-logic.ts`: `listDuplicatePeople` (case-insensitive
 * email groups), `searchPeopleForMerge` (free-text name/email lookup), and
 * `getMergePreview` (read-only preview of what `mergePeople` would do,
 * including the block reason reused from `checkMergeBlocks`).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/people-detect.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people, speeches } from "#/db/schema";
import { hasTestDb, seedPerson, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Import after the mock so the logic module's `#/db` import resolves to testDb.
const { listDuplicatePeople, searchPeopleForMerge, getMergePreview } =
	await import("#/server/people-logic");

describe.skipIf(!hasTestDb)("people-logic duplicate detection", () => {
	const clubIds: string[] = [];
	const personIds: string[] = [];

	afterEach(async () => {
		// clubs cascade → members. Delete clubs BEFORE people so no membership
		// row is left dangling on a deleted person.
		if (clubIds.length)
			await testDb.delete(clubs).where(inArray(clubs.id, clubIds.splice(0)));
		// people cascade → speeches / any remaining memberships or enrollments.
		if (personIds.length)
			await testDb
				.delete(people)
				.where(inArray(people.id, personIds.splice(0)));
	});

	async function makeClub(): Promise<string> {
		const id = randomUUID();
		await testDb
			.insert(clubs)
			.values({ id, name: `Detect Club ${id}`, slug: `detect-${id}` });
		clubIds.push(id);
		return id;
	}

	async function makePerson(overrides?: {
		name?: string;
		email?: string | null;
		customerId?: string | null;
	}): Promise<string> {
		const id = await seedPerson(overrides);
		personIds.push(id);
		return id;
	}

	async function addMembership(
		clubId: string,
		personId: string,
	): Promise<void> {
		await testDb
			.insert(members)
			.values({ clubId, personId, name: "Member", status: "active" });
	}

	it("groups two people sharing a case-insensitive email across clubs", async () => {
		const email = `dup-${randomUUID()}@x.io`;
		const clubA = await makeClub();
		const clubB = await makeClub();
		const personA = await makePerson({ email, name: "Alice" });
		const personB = await makePerson({
			email: email.toUpperCase(),
			name: "Bob",
		});
		await addMembership(clubA, personA);
		await addMembership(clubB, personB);

		const groups = await listDuplicatePeople();
		// Filter to the email this test created — tm_test may hold other
		// duplicate rows from other suites.
		const group = groups.find((g) => g.email === email.toLowerCase());

		expect(group).toBeDefined();
		expect(new Set(group?.people.map((p) => p.id))).toEqual(
			new Set([personA, personB]),
		);
	});

	it("surfaces the block reason without mutating, and reports movedCounts when unblocked", async () => {
		const keeper = await makePerson({ customerId: `PN-${randomUUID()}` });
		const absorbed = await makePerson({ customerId: `PN-${randomUUID()}` });

		const blockedPreview = await getMergePreview(keeper, absorbed);
		expect(blockedPreview.block).toMatch(/customer/i);

		// Read-only: the absorbed person still exists afterward.
		const absRows = await testDb
			.select()
			.from(people)
			.where(eq(people.id, absorbed));
		expect(absRows).toHaveLength(1);

		// An unblocked pair: absorbed carries one speech, nothing should collide.
		const keeper2 = await makePerson();
		const absorbed2 = await makePerson();
		await testDb
			.insert(speeches)
			.values({ personId: absorbed2, title: "Icebreaker" });

		const preview = await getMergePreview(keeper2, absorbed2);
		expect(preview.block).toBeNull();
		expect(preview.movedCounts.speeches).toBe(1);
		expect(preview.movedCounts.memberships).toBe(0);
		expect(preview.movedCounts.collapsed).toBe(0);
		expect(preview.keeper.id).toBe(keeper2);
		expect(preview.absorbed.id).toBe(absorbed2);
	});

	it("searches by name/email substring and short-circuits below 2 chars", async () => {
		const email = `search-${randomUUID()}@x.io`;
		const uniqueName = `Findme-${randomUUID()}`;
		const personId = await makePerson({ name: uniqueName, email });

		const byEmail = await searchPeopleForMerge(email.slice(0, 12));
		expect(byEmail.some((p) => p.id === personId)).toBe(true);

		const byName = await searchPeopleForMerge(uniqueName.slice(0, 10));
		expect(byName.some((p) => p.id === personId)).toBe(true);

		expect(await searchPeopleForMerge("a")).toEqual([]);
		expect(await searchPeopleForMerge("")).toEqual([]);
	});
});

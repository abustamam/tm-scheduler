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
import {
	clubs,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
	speeches,
} from "#/db/schema";
import { hasTestDb, seedPerson, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Import after the mock so the logic module's `#/db` import resolves to testDb.
const { listDuplicatePeople, searchPeopleForMerge, getMergePreview } =
	await import("#/server/people-logic");

describe.skipIf(!hasTestDb)("people-logic duplicate detection", () => {
	const clubIds: string[] = [];
	const personIds: string[] = [];
	const pathIds: string[] = [];

	afterEach(async () => {
		// clubs cascade → members. Delete clubs BEFORE people so no membership
		// row is left dangling on a deleted person.
		if (clubIds.length)
			await testDb.delete(clubs).where(inArray(clubs.id, clubIds.splice(0)));
		// paths cascade → path_enrollments → path_level_progress.
		if (pathIds.length)
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, pathIds.splice(0)));
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

	async function makePath(): Promise<string> {
		const [p] = await testDb
			.insert(pathwaysPaths)
			.values({
				courseCode: `PM-${randomUUID()}`,
				name: "Presentation Mastery",
			})
			.returning({ id: pathwaysPaths.id });
		if (!p) throw new Error("Failed to insert path");
		pathIds.push(p.id);
		return p.id;
	}

	/** Enroll a person in a path with `approvedLevels` approved levels. */
	async function enroll(
		personId: string,
		pathId: string,
		approvedLevels: number,
	): Promise<string> {
		const [e] = await testDb
			.insert(pathEnrollments)
			.values({ personId, pathId })
			.returning({ id: pathEnrollments.id });
		if (!e) throw new Error("Failed to insert enrollment");
		for (let level = 1; level <= approvedLevels; level++) {
			await testDb.insert(pathLevelProgress).values({
				enrollmentId: e.id,
				level,
				completed: 3,
				total: 3,
				approved: true,
			});
		}
		return e.id;
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

	it("partitions movedCounts into collapsed (shared club) vs. memberships (repoint-only club)", async () => {
		const clubA = await makeClub(); // both are members here → collapse.
		const clubB = await makeClub(); // only absorbed is here → repoint.
		const keeper = await makePerson();
		const absorbed = await makePerson();
		await addMembership(clubA, keeper);
		await addMembership(clubA, absorbed);
		await addMembership(clubB, absorbed);

		const preview = await getMergePreview(keeper, absorbed);

		expect(preview.block).toBeNull();
		expect(preview.movedCounts.collapsed).toBe(1);
		expect(preview.movedCounts.memberships).toBe(1);
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

	it("reports movedCounts.enrollments truthfully: keeper-wins collision counts 0, absorbed-only path counts 1", async () => {
		const keeper = await makePerson();
		const absorbed = await makePerson();

		// Shared path P: keeper has 2 approved levels, absorbed has 1 — the
		// keeper wins the collision, so the absorbed's enrollment is DROPPED
		// (not moved) by a real merge. The preview must reflect that: 0.
		const pathP = await makePath();
		await enroll(keeper, pathP, 2);
		await enroll(absorbed, pathP, 1);

		// Absorbed-only path Q: no keeper enrollment, so it always moves — 1.
		const pathQ = await makePath();
		await enroll(absorbed, pathQ, 0);

		const preview = await getMergePreview(keeper, absorbed);

		expect(preview.movedCounts.enrollments).toBe(1);
	});
});

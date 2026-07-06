/**
 * DB-backed tests for Pathways sync upsert + identity match. Runs the plain
 * `syncClubProgress` against the test DB.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/pathways-sync.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
} from "#/db/schema";
import type { ParsedMemberPath } from "#/lib/basecamp-progress";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { syncClubProgress } = await import("./pathways-sync-logic");

function mp(over: Partial<ParsedMemberPath>): ParsedMemberPath {
	return {
		basecampUserId: "999",
		name: "Test Member",
		email: "test@example.com",
		courseCode: "8701",
		pathName: "Presentation Mastery",
		levels: [
			{ level: 1, completed: 5, total: 5, approved: true },
			{ level: 2, completed: 2, total: 4, approved: false },
		],
		...over,
	};
}

const createdPersonIds: string[] = [];

async function makePerson(over: Partial<typeof people.$inferInsert> = {}) {
	const id = randomUUID();
	await testDb
		.insert(people)
		.values({ id, name: "P", email: "test@example.com", ...over });
	createdPersonIds.push(id);
	return id;
}

async function localCleanup() {
	// Pathways tables are exclusive to this suite — safe to clear wholesale.
	await testDb.delete(pathLevelProgress);
	await testDb.delete(pathEnrollments);
	await testDb.delete(pathwaysPaths);
	// `people` is shared across suites — remove only what this suite created.
	if (createdPersonIds.length > 0) {
		await testDb.delete(people).where(inArray(people.id, createdPersonIds));
		createdPersonIds.length = 0;
	}
}

describe.skipIf(!hasTestDb)("syncClubProgress", () => {
	beforeEach(localCleanup);
	afterEach(localCleanup);

	it("matches by email, upserts path/enrollment/levels, sets basecampUserId", async () => {
		const personId = await makePerson({ email: "match@example.com" });
		const res = await syncClubProgress([
			mp({ email: "match@example.com", basecampUserId: "123" }),
		]);

		expect(res.matched).toBe(1);
		expect(res.unmatched).toEqual([]);

		const [p] = await testDb
			.select({ bc: people.basecampUserId })
			.from(people)
			.where(eq(people.id, personId));
		expect(p.bc).toBe("123");

		const [path] = await testDb
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, "8701"));
		expect(path).toBeDefined();

		const [enr] = await testDb
			.select({ id: pathEnrollments.id })
			.from(pathEnrollments)
			.where(
				and(
					eq(pathEnrollments.personId, personId),
					eq(pathEnrollments.pathId, path.id),
				),
			);
		expect(enr).toBeDefined();

		const levels = await testDb
			.select()
			.from(pathLevelProgress)
			.where(eq(pathLevelProgress.enrollmentId, enr.id));
		expect(levels).toHaveLength(2);
	});

	it("prefers a stored basecampUserId over email on re-sync (survives email change)", async () => {
		const personId = await makePerson({
			email: "old@example.com",
			basecampUserId: "555",
		});
		const res = await syncClubProgress([
			mp({ email: "changed@example.com", basecampUserId: "555" }),
		]);
		expect(res.matched).toBe(1);
		const enr = await testDb
			.select()
			.from(pathEnrollments)
			.where(eq(pathEnrollments.personId, personId));
		expect(enr).toHaveLength(1);
	});

	it("re-sync updates counts idempotently (no duplicate rows)", async () => {
		await makePerson({ email: "idem@example.com" });
		await syncClubProgress([
			mp({ email: "idem@example.com", basecampUserId: "1" }),
		]);
		await syncClubProgress([
			mp({
				email: "idem@example.com",
				basecampUserId: "1",
				levels: [{ level: 2, completed: 4, total: 4, approved: true }],
			}),
		]);
		const paths = await testDb.select().from(pathwaysPaths);
		expect(paths).toHaveLength(1);
		const enrs = await testDb.select().from(pathEnrollments);
		expect(enrs).toHaveLength(1);
		const [l2] = await testDb
			.select()
			.from(pathLevelProgress)
			.where(eq(pathLevelProgress.level, 2));
		expect(l2.approved).toBe(true);
		expect(l2.completed).toBe(4);
	});

	it("reports an unknown email as unmatched (no person created)", async () => {
		// Delta check, not a global `people` count: vitest runs test files in
		// parallel workers against the shared tm_test, and sibling suites (e.g.
		// roster-mgmt's merge/remove cases) leave orphaned people the club
		// cascade can't reclaim. Assert THIS sync created nobody instead.
		const before = (await testDb.select().from(people)).length;
		const res = await syncClubProgress([
			mp({ email: "nobody@example.com", basecampUserId: "77" }),
		]);
		expect(res.matched).toBe(0);
		expect(res.unmatched).toEqual([
			{
				name: "Test Member",
				email: "nobody@example.com",
				basecampUserId: "77",
			},
		]);
		expect(await testDb.select().from(people)).toHaveLength(before);
	});

	it("reports an email shared by 2+ people as unmatched (ambiguous)", async () => {
		await makePerson({ email: "shared@example.com" });
		await makePerson({ email: "shared@example.com" });
		const res = await syncClubProgress([
			mp({ email: "shared@example.com", basecampUserId: "88" }),
		]);
		expect(res.matched).toBe(0);
		expect(res.unmatched).toHaveLength(1);
	});
});

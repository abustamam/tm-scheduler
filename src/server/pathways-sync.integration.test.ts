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
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	clubs,
	members,
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

// One test club shared by every case in this suite — identity match is now
// scoped to roster members of the club being synced, so every matched person
// needs a `members` row here.
let clubId: string;
const createdPersonIds: string[] = [];

/** Create a Person AND a `members` row linking them to the test club. */
async function makeMember(
	over: Partial<typeof people.$inferInsert> = {},
): Promise<string> {
	const id = randomUUID();
	const name = over.name ?? "P";
	const email = over.email ?? "test@example.com";
	await testDb.insert(people).values({ id, name, email, ...over });
	createdPersonIds.push(id);
	await testDb.insert(members).values({ clubId, personId: id, name, email });
	return id;
}

/** Create a Person with NO membership in the test club (roster outsider). */
async function makeNonMember(
	over: Partial<typeof people.$inferInsert> = {},
): Promise<string> {
	const id = randomUUID();
	await testDb
		.insert(people)
		.values({ id, name: "Outsider", email: "outsider@example.com", ...over });
	createdPersonIds.push(id);
	return id;
}

async function localCleanup() {
	// Pathways tables are exclusive to this suite — safe to clear wholesale.
	await testDb.delete(pathLevelProgress);
	await testDb.delete(pathEnrollments);
	await testDb.delete(pathwaysPaths);
	// `people`/`members` are shared across suites — remove only this suite's rows.
	if (createdPersonIds.length > 0) {
		await testDb
			.delete(members)
			.where(inArray(members.personId, createdPersonIds));
		await testDb.delete(people).where(inArray(people.id, createdPersonIds));
		createdPersonIds.length = 0;
	}
}

describe.skipIf(!hasTestDb)("syncClubProgress", () => {
	beforeAll(async () => {
		clubId = randomUUID();
		await testDb
			.insert(clubs)
			.values({ id: clubId, name: "Test Club", slug: `test-club-${clubId}` });
	});

	afterAll(async () => {
		await testDb.delete(clubs).where(eq(clubs.id, clubId));
	});

	beforeEach(localCleanup);
	afterEach(localCleanup);

	it("matches by email, upserts path/enrollment/levels, sets basecampUserId", async () => {
		const personId = await makeMember({ email: "match@example.com" });
		const res = await syncClubProgress(clubId, [
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
		const personId = await makeMember({
			email: "old@example.com",
			basecampUserId: "555",
		});
		const res = await syncClubProgress(clubId, [
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
		await makeMember({ email: "idem@example.com" });
		await syncClubProgress(clubId, [
			mp({ email: "idem@example.com", basecampUserId: "1" }),
		]);
		await syncClubProgress(clubId, [
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
		const res = await syncClubProgress(clubId, [
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
		// Scoped existence check, not a global `people` count: vitest runs test
		// files in parallel workers against the shared tm_test, so a global
		// before/after count flakes when a sibling suite writes people mid-test.
		// The sync must not have created a person for this unmatched row.
		const created = await testDb
			.select()
			.from(people)
			.where(eq(people.email, "nobody@example.com"));
		expect(created).toHaveLength(0);
	});

	it("reports an identity anomaly as unmatched and never clobbers a stored basecampUserId", async () => {
		const personId = await makeMember({
			email: "e@example.com",
			basecampUserId: "111",
		});
		const res = await syncClubProgress(clubId, [
			mp({ email: "e@example.com", basecampUserId: "222" }),
		]);
		expect(res.matched).toBe(0);
		expect(res.unmatched).toHaveLength(1);

		const [p] = await testDb
			.select({ bc: people.basecampUserId })
			.from(people)
			.where(eq(people.id, personId));
		expect(p.bc).toBe("111");
	});

	it("reports an email shared by 2+ people as unmatched (ambiguous)", async () => {
		// Both must be members of this club — otherwise the club-scoped lookup
		// would resolve to a single (non-ambiguous) match on its own.
		await makeMember({ email: "shared@example.com" });
		await makeMember({ email: "shared@example.com" });
		const res = await syncClubProgress(clubId, [
			mp({ email: "shared@example.com", basecampUserId: "88" }),
		]);
		expect(res.matched).toBe(0);
		expect(res.unmatched).toHaveLength(1);
	});

	it("does not match a person who exists but isn't a roster member of this club", async () => {
		// Same email AND basecampUserId as the payload, but no `members` row in
		// clubId — this is the authorization-scoping fix: a match anywhere in
		// `people` is not enough, they must be on THIS club's roster.
		const outsiderId = await makeNonMember({
			email: "outsider@example.com",
			basecampUserId: "321",
		});
		const res = await syncClubProgress(clubId, [
			mp({ email: "outsider@example.com", basecampUserId: "321" }),
		]);
		expect(res.matched).toBe(0);
		expect(res.unmatched).toEqual([
			{
				name: "Test Member",
				email: "outsider@example.com",
				basecampUserId: "321",
			},
		]);

		// No pathway rows written for the outsider.
		const enrs = await testDb
			.select()
			.from(pathEnrollments)
			.where(eq(pathEnrollments.personId, outsiderId));
		expect(enrs).toHaveLength(0);

		// basecampUserId is not written onto the outsider's people row either.
		const [p] = await testDb
			.select({ bc: people.basecampUserId })
			.from(people)
			.where(eq(people.id, outsiderId));
		expect(p.bc).toBe("321"); // unchanged from setup — never touched
	});
});

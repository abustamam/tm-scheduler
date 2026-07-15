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

// vitest runs test FILES in parallel workers against the same shared tm_test
// DB, and pathways-read.integration.test.ts touches the same pathwaysPaths /
// pathEnrollments / pathLevelProgress tables. A suite-unique course code
// (courseCode is globally unique) keeps this suite's rows disjoint from that
// suite's, so cleanup can scope to "rows this suite created" instead of
// wholesale-truncating shared tables out from under a sibling suite.
const CODE = `8701-${randomUUID().slice(0, 8)}`;

function mp(over: Partial<ParsedMemberPath>): ParsedMemberPath {
	return {
		basecampUserId: "999",
		name: "Test Member",
		email: "test@example.com",
		courseCode: CODE,
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
// Extra course codes a case creates beyond CODE (e.g. the unseen-path case) —
// cleaned up alongside CODE so shared catalog rows don't leak across runs.
const createdPathCodes: string[] = [];
// Extra clubs a case creates beyond the shared test club (the multi-club
// first-syncer-wins case) — cleaned up so club rows don't leak across runs.
const createdClubIds: string[] = [];

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
	// Scope to this suite's own tagged course code — pathEnrollments and
	// pathLevelProgress cascade-delete via FK (onDelete: "cascade"), so
	// deleting the tagged pathwaysPaths row is enough.
	await testDb
		.delete(pathwaysPaths)
		.where(inArray(pathwaysPaths.courseCode, [CODE, ...createdPathCodes]));
	createdPathCodes.length = 0;
	// `people`/`members` are shared across suites — remove only this suite's rows.
	if (createdPersonIds.length > 0) {
		await testDb
			.delete(members)
			.where(inArray(members.personId, createdPersonIds));
		await testDb.delete(people).where(inArray(people.id, createdPersonIds));
		createdPersonIds.length = 0;
	}
	// Extra clubs — deleted AFTER level rows (via CODE cascade above) and their
	// memberships (via personId above), so no credited_club_id / members FK is
	// left dangling. The shared `clubId` is owned by afterAll, not here.
	if (createdClubIds.length > 0) {
		await testDb.delete(clubs).where(inArray(clubs.id, createdClubIds));
		createdClubIds.length = 0;
	}
}

/** Read the single path_level_progress row for a person's CODE-path level. */
async function readLevel(personId: string, level: number) {
	const [path] = await testDb
		.select({ id: pathwaysPaths.id })
		.from(pathwaysPaths)
		.where(eq(pathwaysPaths.courseCode, CODE));
	const [enr] = await testDb
		.select({ id: pathEnrollments.id })
		.from(pathEnrollments)
		.where(
			and(
				eq(pathEnrollments.personId, personId),
				eq(pathEnrollments.pathId, path.id),
			),
		);
	const [row] = await testDb
		.select()
		.from(pathLevelProgress)
		.where(
			and(
				eq(pathLevelProgress.enrollmentId, enr.id),
				eq(pathLevelProgress.level, level),
			),
		);
	return row;
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
			.where(eq(pathwaysPaths.courseCode, CODE));
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

	it("never overwrites an existing shared-catalog path name (insert-if-missing)", async () => {
		// pathways_paths is a globally shared catalog: one club's sync must not be
		// able to rename an entry every other club displays. Seed the row with a
		// canonical name, then sync a payload claiming the same courseCode with a
		// DIFFERENT name — the stored name must be unchanged and the sync succeeds.
		await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: CODE, name: "Presentation Mastery" });
		const personId = await makeMember({ email: "catalog@example.com" });
		const res = await syncClubProgress(clubId, [
			mp({
				email: "catalog@example.com",
				basecampUserId: "cat1",
				pathName: "Renamed By Attacker",
			}),
		]);
		expect(res.matched).toBe(1);

		const [path] = await testDb
			.select({ name: pathwaysPaths.name })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, CODE));
		expect(path.name).toBe("Presentation Mastery");

		// Enrollment/levels still written for the matched member.
		const enrs = await testDb
			.select()
			.from(pathEnrollments)
			.where(eq(pathEnrollments.personId, personId));
		expect(enrs).toHaveLength(1);
	});

	it("creates a new catalog path for an unseen courseCode", async () => {
		const unseen = `unseen-${randomUUID().slice(0, 8)}`;
		createdPathCodes.push(unseen);
		await makeMember({ email: "newpath@example.com" });
		const res = await syncClubProgress(clubId, [
			mp({
				email: "newpath@example.com",
				basecampUserId: "np1",
				courseCode: unseen,
				pathName: "Dynamic Leadership",
			}),
		]);
		expect(res.matched).toBe(1);

		const [path] = await testDb
			.select({ name: pathwaysPaths.name })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, unseen));
		expect(path.name).toBe("Dynamic Leadership");
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
		const personId = await makeMember({ email: "idem@example.com" });
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
		// Scoped to this suite's tagged course code / person — a sibling suite
		// (pathways-read.integration.test.ts) shares these tables and runs
		// concurrently, so an unscoped whole-table select would flake.
		const paths = await testDb
			.select()
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, CODE));
		expect(paths).toHaveLength(1);
		const enrs = await testDb
			.select()
			.from(pathEnrollments)
			.where(eq(pathEnrollments.personId, personId));
		expect(enrs).toHaveLength(1);
		const [l2] = await testDb
			.select()
			.from(pathLevelProgress)
			.where(
				and(
					eq(pathLevelProgress.enrollmentId, enrs[0].id),
					eq(pathLevelProgress.level, 2),
				),
			);
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

	// --- Completion attribution (ADR-0022, #116) -------------------------------

	it("stamps completedAt + creditedClubId when a level is witnessed flipping approved false→true", async () => {
		const personId = await makeMember({ email: "flip@example.com" });
		const before = Date.now();

		// First sync: level not yet approved → columns stay null.
		await syncClubProgress(clubId, [
			mp({
				email: "flip@example.com",
				basecampUserId: "f1",
				levels: [{ level: 1, completed: 2, total: 4, approved: false }],
			}),
		]);
		let row = await readLevel(personId, 1);
		expect(row.completedAt).toBeNull();
		expect(row.creditedClubId).toBeNull();

		// Second sync: approved flips false→true → stamp date + syncing club.
		await syncClubProgress(clubId, [
			mp({
				email: "flip@example.com",
				basecampUserId: "f1",
				levels: [{ level: 1, completed: 4, total: 4, approved: true }],
			}),
		]);
		row = await readLevel(personId, 1);
		expect(row.completedAt).toBeInstanceOf(Date);
		expect(row.completedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
			before - 1000,
		);
		expect(row.creditedClubId).toBe(clubId);
	});

	it("leaves completion columns null for a level already approved on the enrollment's first sync (cold start)", async () => {
		const personId = await makeMember({ email: "cold@example.com" });
		await syncClubProgress(clubId, [
			mp({
				email: "cold@example.com",
				basecampUserId: "c1",
				levels: [{ level: 1, completed: 5, total: 5, approved: true }],
			}),
		]);
		const row = await readLevel(personId, 1);
		// The level IS done, but we never witnessed the transition — so no
		// fabricated date or club.
		expect(row.approved).toBe(true);
		expect(row.completedAt).toBeNull();
		expect(row.creditedClubId).toBeNull();
	});

	it("leaves completion columns null for a never-approved level", async () => {
		const personId = await makeMember({ email: "never@example.com" });
		await syncClubProgress(clubId, [
			mp({
				email: "never@example.com",
				basecampUserId: "n1",
				levels: [{ level: 1, completed: 1, total: 5, approved: false }],
			}),
		]);
		await syncClubProgress(clubId, [
			mp({
				email: "never@example.com",
				basecampUserId: "n1",
				levels: [{ level: 1, completed: 3, total: 5, approved: false }],
			}),
		]);
		const row = await readLevel(personId, 1);
		expect(row.completedAt).toBeNull();
		expect(row.creditedClubId).toBeNull();
	});

	it("preserves the original completion stamp across true→false→true churn (write-once)", async () => {
		const personId = await makeMember({ email: "churn@example.com" });
		await syncClubProgress(clubId, [
			mp({
				email: "churn@example.com",
				basecampUserId: "ch1",
				levels: [{ level: 1, completed: 2, total: 4, approved: false }],
			}),
		]);
		// Witness the completion.
		await syncClubProgress(clubId, [
			mp({
				email: "churn@example.com",
				basecampUserId: "ch1",
				levels: [{ level: 1, completed: 4, total: 4, approved: true }],
			}),
		]);
		const first = await readLevel(personId, 1);
		expect(first.completedAt).toBeInstanceOf(Date);

		// Base Camp re-opens the level (true→false)…
		await syncClubProgress(clubId, [
			mp({
				email: "churn@example.com",
				basecampUserId: "ch1",
				levels: [{ level: 1, completed: 3, total: 4, approved: false }],
			}),
		]);
		// …then it is approved again (false→true). Write-once: original wins.
		await syncClubProgress(clubId, [
			mp({
				email: "churn@example.com",
				basecampUserId: "ch1",
				levels: [{ level: 1, completed: 4, total: 4, approved: true }],
			}),
		]);
		const after = await readLevel(personId, 1);
		expect(after.completedAt?.getTime()).toBe(first.completedAt?.getTime());
		expect(after.creditedClubId).toBe(clubId);
	});

	it("does not let a second club steal credit once the first club has stamped (first-syncer-wins)", async () => {
		const personId = await makeMember({ email: "multi@example.com" });
		// Same person, second club on the roster — they share ONE enrollment
		// (person + path), so both clubs' syncs hit the same level row.
		const secondClubId = randomUUID();
		createdClubIds.push(secondClubId);
		await testDb.insert(clubs).values({
			id: secondClubId,
			name: "Second Club",
			slug: `second-club-${secondClubId}`,
		});
		await testDb.insert(members).values({
			clubId: secondClubId,
			personId,
			name: "Multi",
			email: "multi@example.com",
		});

		// Club A witnesses the completion → A is credited.
		await syncClubProgress(clubId, [
			mp({
				email: "multi@example.com",
				basecampUserId: "m1",
				levels: [{ level: 1, completed: 2, total: 4, approved: false }],
			}),
		]);
		await syncClubProgress(clubId, [
			mp({
				email: "multi@example.com",
				basecampUserId: "m1",
				levels: [{ level: 1, completed: 4, total: 4, approved: true }],
			}),
		]);
		const afterA = await readLevel(personId, 1);
		expect(afterA.creditedClubId).toBe(clubId);
		const stampedAt = afterA.completedAt?.getTime();

		// Club B later syncs the same (already-approved) shared enrollment.
		await syncClubProgress(secondClubId, [
			mp({
				email: "multi@example.com",
				basecampUserId: "m1",
				levels: [{ level: 1, completed: 4, total: 4, approved: true }],
			}),
		]);
		const afterB = await readLevel(personId, 1);
		// Credit and date are unchanged — A got there first.
		expect(afterB.creditedClubId).toBe(clubId);
		expect(afterB.completedAt?.getTime()).toBe(stampedAt);
	});
});

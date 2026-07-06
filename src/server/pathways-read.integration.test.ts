/**
 * DB-backed tests for `pathwaysForPerson` (and `pathwaysForMember`) read
 * paths. Runs the plain read functions against the test DB.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/pathways-read.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
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
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { pathwaysForPerson, pathwaysForMember, pathwaysByMember } = await import(
	"./pathways-read-logic"
);

// One test club shared by every case in this suite.
let clubId: string;
const createdPersonIds: string[] = [];

// vitest runs test FILES in parallel workers against the same shared tm_test
// DB, and pathways-sync.integration.test.ts touches the same pathwaysPaths /
// pathEnrollments / pathLevelProgress tables. A suite-unique course-code
// suffix keeps this suite's rows disjoint from that suite's (courseCode is
// globally unique), so cleanup can scope to "rows this suite created" instead
// of wholesale-truncating shared tables out from under a sibling suite.
const SUITE_TAG = randomUUID().slice(0, 8);
const code = (base: string) => `${base}-${SUITE_TAG}`;

/** Create a Person AND a `members` row linking them to the test club. */
async function makeMember(
	over: Partial<typeof people.$inferInsert> = {},
): Promise<{ personId: string; memberId: string }> {
	const personId = randomUUID();
	const name = over.name ?? "P";
	const email = over.email ?? "test@example.com";
	await testDb.insert(people).values({ id: personId, name, email, ...over });
	createdPersonIds.push(personId);
	const [row] = await testDb
		.insert(members)
		.values({ clubId, personId, name, email })
		.returning({ id: members.id });
	return { personId, memberId: row.id };
}

/** Create a path + enrollment + two level rows for a person. */
async function enrollInPath(
	personId: string,
	over: { courseCode: string; pathName: string },
) {
	const [path] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode: over.courseCode, name: over.pathName })
		.returning({ id: pathwaysPaths.id });

	const [enr] = await testDb
		.insert(pathEnrollments)
		.values({ personId, pathId: path.id })
		.returning({ id: pathEnrollments.id });

	await testDb.insert(pathLevelProgress).values([
		{ enrollmentId: enr.id, level: 1, completed: 5, total: 5, approved: true },
		{
			enrollmentId: enr.id,
			level: 2,
			completed: 2,
			total: 4,
			approved: false,
		},
	]);

	return { pathId: path.id, enrollmentId: enr.id };
}

async function localCleanup() {
	// Scope to this suite's own tagged course codes — pathEnrollments and
	// pathLevelProgress cascade-delete via FK (onDelete: "cascade"), so
	// deleting the tagged pathwaysPaths rows is enough.
	await testDb
		.delete(pathwaysPaths)
		.where(like(pathwaysPaths.courseCode, `%-${SUITE_TAG}`));
	// `people`/`members` are shared across suites — remove only this suite's rows.
	if (createdPersonIds.length > 0) {
		await testDb
			.delete(members)
			.where(inArray(members.personId, createdPersonIds));
		await testDb.delete(people).where(inArray(people.id, createdPersonIds));
		createdPersonIds.length = 0;
	}
}

describe.skipIf(!hasTestDb)("pathwaysForPerson / pathwaysForMember", () => {
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

	it("returns one PathViewModel with the expected ringPercent/currentLevel", async () => {
		const { personId } = await makeMember({ email: "one-path@example.com" });
		await enrollInPath(personId, {
			courseCode: code("8701"),
			pathName: "Presentation Mastery",
		});

		const result = await pathwaysForPerson(personId);

		expect(result).toHaveLength(1);
		const [vm] = result;
		expect(vm.courseCode).toBe(code("8701"));
		expect(vm.pathName).toBe("Presentation Mastery");
		expect(vm.levels).toHaveLength(2);
		expect(vm.currentLevel).toBe(2);
		// done = min(5,5) + min(2,4) = 5 + 2 = 7; total = 5 + 4 = 9
		// 7 / 9 = 0.777... * 100 = 77.77... -> Math.round -> 78
		expect(vm.ringPercent).toBe(78);
	});

	it("returns two PathViewModels when the person is enrolled in a second path", async () => {
		const { personId } = await makeMember({ email: "two-paths@example.com" });
		await enrollInPath(personId, {
			courseCode: code("8701"),
			pathName: "Presentation Mastery",
		});
		await enrollInPath(personId, {
			courseCode: code("8702"),
			pathName: "Dynamic Leadership",
		});

		const result = await pathwaysForPerson(personId);

		expect(result).toHaveLength(2);
		const courseCodes = result.map((vm) => vm.courseCode).sort();
		expect(courseCodes).toEqual([code("8701"), code("8702")].sort());
	});

	it("pathwaysForMember resolves the same view models for that member's person", async () => {
		const { personId, memberId } = await makeMember({
			email: "member-lookup@example.com",
		});
		await enrollInPath(personId, {
			courseCode: code("8701"),
			pathName: "Presentation Mastery",
		});

		const viaMember = await pathwaysForMember(clubId, memberId);
		const viaPerson = await pathwaysForPerson(personId);

		expect(viaMember).toEqual(viaPerson);
		expect(viaMember).toHaveLength(1);
	});

	it("pathwaysForMember returns [] for a memberId not in the club", async () => {
		const result = await pathwaysForMember(clubId, randomUUID());
		expect(result).toEqual([]);
	});

	it("pathwaysByMember batches every member's paths in one query, keyed by member id", async () => {
		const enrolled = await makeMember({ email: "batch-enrolled@example.com" });
		const unenrolled = await makeMember({
			email: "batch-unenrolled@example.com",
		});
		await enrollInPath(enrolled.personId, {
			courseCode: code("8701"),
			pathName: "Presentation Mastery",
		});

		const map = await pathwaysByMember(clubId);

		expect(map.has(unenrolled.memberId)).toBe(false);
		const paths = map.get(enrolled.memberId);
		expect(paths).toHaveLength(1);
		expect(paths?.[0].courseCode).toBe(code("8701"));
		expect(paths?.[0].pathName).toBe("Presentation Mastery");
		expect(paths).toEqual(await pathwaysForMember(clubId, enrolled.memberId));
	});
});

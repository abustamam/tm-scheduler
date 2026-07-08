/**
 * DB-backed tests for /detail catalog reconciliation + mirror upsert.
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/pathways-detail.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	bcmProjectProgress,
	pathEnrollments,
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
	people,
} from "#/db/schema";
import type { ParsedDetail } from "#/lib/basecamp-detail";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { reconcileCatalog, syncClubDetail } = await import(
	"./pathways-detail-logic"
);

const CODE = `8700-${randomUUID().slice(0, 8)}`;

let pathId: string;
let seededIceId: string;

async function seed() {
	const [p] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode: CODE, name: "Motivational Strategies" })
		.returning({ id: pathwaysPaths.id });
	pathId = p.id;
	// A hand-seeded catalog row with NO block id yet (the fallback FK target).
	const [ice] = await testDb
		.insert(pathwaysProjects)
		.values({ pathId, level: 1, name: "Ice Breaker", isRequired: true })
		.returning({ id: pathwaysProjects.id });
	seededIceId = ice.id;
}

function detail(over: Partial<ParsedDetail> = {}): ParsedDetail {
	return {
		basecampUserId: "122747",
		courseCode: CODE,
		levels: [
			{ level: 1, minReqElectives: 0 },
			{ level: 3, minReqElectives: 2 },
		],
		projects: [
			// matches the seeded row → should be STAMPED (same id)
			{
				blockId: "b-ice",
				name: "Ice Breaker",
				level: 1,
				isRequired: true,
				complete: true,
				speechTitle: null,
				speechDate: null,
			},
			// required, not seeded → should be CREATED
			{
				blockId: "b-purpose",
				name: "Writing a Speech with Purpose",
				level: 1,
				isRequired: true,
				complete: true,
				speechTitle: null,
				speechDate: null,
			},
			// elective, not seeded → should be REPORTED, not created
			{
				blockId: "b-social",
				name: "Deliver Social Speeches",
				level: 3,
				isRequired: false,
				complete: true,
				speechTitle: null,
				speechDate: null,
			},
		],
		...over,
	};
}

describe.skipIf(!hasTestDb)("reconcileCatalog", () => {
	beforeAll(seed);
	afterAll(async () => {
		await testDb.delete(pathwaysPaths).where(eq(pathwaysPaths.id, pathId));
		// pathwaysProjects + pathwaysPathLevels cascade on path delete.
	});

	it("stamps matched rows, creates required, reports electives, upserts levels", async () => {
		// Same detail twice = the batch shape (one ParsedDetail per member×path).
		// The elective must be reported ONCE, not once per member — proves dedup.
		const res = await reconcileCatalog([detail(), detail()]);

		// Stamped the existing Ice Breaker row IN PLACE (same id → FK preserved).
		const ice = await testDb
			.select()
			.from(pathwaysProjects)
			.where(eq(pathwaysProjects.id, seededIceId));
		expect(ice[0].bcmBlockId).toBe("b-ice");

		// Created the required "Writing a Speech with Purpose".
		const created = await testDb
			.select()
			.from(pathwaysProjects)
			.where(
				and(
					eq(pathwaysProjects.pathId, pathId),
					eq(pathwaysProjects.bcmBlockId, "b-purpose"),
				),
			);
		expect(created).toHaveLength(1);
		expect(created[0].isRequired).toBe(true);

		// Elective NOT created; reported instead.
		const socialRows = await testDb
			.select()
			.from(pathwaysProjects)
			.where(
				and(
					eq(pathwaysProjects.pathId, pathId),
					eq(pathwaysProjects.name, "Deliver Social Speeches"),
				),
			);
		expect(socialRows).toHaveLength(0);
		// Deduped across the two identical details → one entry, not two.
		expect(res.unmatchedElectives).toHaveLength(1);
		expect(res.unmatchedElectives).toEqual([
			{ courseCode: CODE, name: "Deliver Social Speeches", level: 3 },
		]);

		expect(res.projectsStamped).toBe(1);
		expect(res.projectsDerived).toBe(1);

		// path_levels upserted.
		const levels = await testDb
			.select()
			.from(pathwaysPathLevels)
			.where(eq(pathwaysPathLevels.pathId, pathId));
		expect(levels.find((l) => l.level === 3)?.minReqElectives).toBe(2);

		// The returned map lets the caller resolve blockId → catalog projectId.
		expect(res.projectIdByBlockId.get("b-ice")).toBe(seededIceId);
		expect(res.projectIdByBlockId.get("b-purpose")).toBe(created[0].id);
		expect(res.projectIdByBlockId.has("b-social")).toBe(false);
	});

	// NOTE: depends on the row stamped by the first test (shared beforeAll seed +
	// b-ice stamped above) — relies on file execution order. If these are ever
	// reordered or parallelized, seed the stamped state here explicitly first.
	it("re-stamping by block id is idempotent and updates a renamed project", async () => {
		const renamed = detail({
			projects: [
				{
					blockId: "b-ice",
					name: "Ice Breaker (Revised)",
					level: 1,
					isRequired: true,
					complete: true,
					speechTitle: null,
					speechDate: null,
				},
			],
			levels: [{ level: 1, minReqElectives: 0 }],
		});
		const res = await reconcileCatalog([renamed]);
		const ice = await testDb
			.select()
			.from(pathwaysProjects)
			.where(eq(pathwaysProjects.id, seededIceId));
		// Same row (matched by block id), name updated, no duplicate created.
		expect(ice[0].name).toBe("Ice Breaker (Revised)");
		expect(res.projectsStamped).toBe(0); // already stamped
	});

	it("two concurrent derives of the same new required project never throw a unique violation", async () => {
		// pathways_projects is a globally shared catalog table — two concurrent
		// ingests (two clubs, two officers, or the unattended sync) can derive the
		// same brand-new project at the same time. Both reconcileCatalog calls see
		// "no existing row" and race to insert; the onConflictDoNothing + reselect
		// fallback must make the loser a no-op instead of throwing.
		const suffix = randomUUID().slice(0, 8);
		const blockId = `b-concurrent-${suffix}`;
		const name = `Concurrent Required Project ${suffix}`;
		const concurrent = detail({
			levels: [{ level: 2, minReqElectives: 0 }],
			projects: [
				{
					blockId,
					name,
					level: 2,
					isRequired: true,
					complete: false,
					speechTitle: null,
					speechDate: null,
				},
			],
		});

		const results = await Promise.all([
			reconcileCatalog([concurrent]),
			reconcileCatalog([concurrent]),
		]);

		// Neither call rejected (Promise.all resolved to get here at all).
		expect(results).toHaveLength(2);

		const rows = await testDb
			.select()
			.from(pathwaysProjects)
			.where(eq(pathwaysProjects.bcmBlockId, blockId));
		expect(rows).toHaveLength(1);

		// Both calls resolved the block id to the SAME (only) row.
		for (const res of results) {
			expect(res.projectIdByBlockId.get(blockId)).toBe(rows[0].id);
		}
	});
});

describe.skipIf(!hasTestDb)("syncClubDetail", () => {
	const D_CODE = `8700-${randomUUID().slice(0, 8)}`;
	const BC_ID = `77${randomUUID().slice(0, 6)}`;
	let seed: SeededClub;
	let clubId: string;
	let enrollmentId: string;
	let iceId: string;

	beforeAll(async () => {
		seed = await seedClub();
		clubId = seed.clubId;
		// Give the seeded roster person a Base Camp id (the detail join key).
		await testDb
			.update(people)
			.set({ basecampUserId: BC_ID })
			.where(eq(people.id, seed.personId));
		const [path] = await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: D_CODE, name: "Motivational Strategies" })
			.returning({ id: pathwaysPaths.id });
		const [proj] = await testDb
			.insert(pathwaysProjects)
			.values({
				pathId: path.id,
				level: 1,
				name: "Ice Breaker",
				isRequired: true,
				bcmBlockId: `ice-${D_CODE}`,
			})
			.returning({ id: pathwaysProjects.id });
		iceId = proj.id;
		const [enr] = await testDb
			.insert(pathEnrollments)
			.values({ personId: seed.personId, pathId: path.id })
			.returning({ id: pathEnrollments.id });
		enrollmentId = enr.id;
	});

	afterAll(async () => {
		// people delete cascades enrollments → bcm_project_progress; path delete
		// cascades projects + path_levels; cleanup removes the club + users.
		await testDb
			.delete(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, D_CODE));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	function detailFor(over: Partial<ParsedDetail> = {}): ParsedDetail {
		return {
			basecampUserId: BC_ID,
			courseCode: D_CODE,
			levels: [{ level: 1, minReqElectives: 0 }],
			projects: [
				{
					blockId: `ice-${D_CODE}`,
					name: "Ice Breaker",
					level: 1,
					isRequired: true,
					complete: true,
					speechTitle: "First Speech",
					speechDate: new Date("2025-01-05T08:00:00Z"),
				},
			],
			...over,
		};
	}

	it("writes a mirror row for a matched enrollment", async () => {
		const res = await syncClubDetail(clubId, [detailFor()]);
		expect(res.membersWithDetail).toBe(1);
		const rows = await testDb
			.select()
			.from(bcmProjectProgress)
			.where(eq(bcmProjectProgress.enrollmentId, enrollmentId));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			projectId: iceId,
			complete: true,
			speechTitle: "First Speech",
		});
	});

	it("replace-per-enrollment removes rows dropped from the latest detail", async () => {
		// Second sync with NO projects → the previous Ice Breaker row is removed.
		await syncClubDetail(clubId, [detailFor({ projects: [] })]);
		const rows = await testDb
			.select()
			.from(bcmProjectProgress)
			.where(eq(bcmProjectProgress.enrollmentId, enrollmentId));
		expect(rows).toHaveLength(0);
	});

	it("leaves an enrollment absent from the batch untouched (last-known-good)", async () => {
		await syncClubDetail(clubId, [detailFor()]); // re-populate
		// Empty batch: nothing to sync → existing rows survive.
		const res = await syncClubDetail(clubId, []);
		expect(res.membersWithDetail).toBe(0);
		const rows = await testDb
			.select()
			.from(bcmProjectProgress)
			.where(eq(bcmProjectProgress.enrollmentId, enrollmentId));
		expect(rows).toHaveLength(1);
	});

	it("reports an unmatched detail member (no enrollment)", async () => {
		const res = await syncClubDetail(clubId, [
			detailFor({ basecampUserId: "does-not-exist" }),
		]);
		expect(res.unmatchedMembers).toBe(1);
		expect(res.membersWithDetail).toBe(0);
	});
});

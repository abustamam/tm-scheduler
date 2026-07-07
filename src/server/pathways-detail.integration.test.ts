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
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
} from "#/db/schema";
import type { ParsedDetail } from "#/lib/basecamp-detail";
import { hasTestDb, testDb } from "#/test/db";

// (Task 4 extends these imports: add `people, pathEnrollments, bcmProjectProgress`
//  from #/db/schema and `cleanup, seedClub, type SeededClub` from #/test/db.)

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { reconcileCatalog } = await import("./pathways-detail-logic");

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
});

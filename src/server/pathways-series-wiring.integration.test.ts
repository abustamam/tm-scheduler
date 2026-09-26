/**
 * The DB half of #921: `series` and `status` actually reach the read model
 * from the database, through BOTH loaders, and the speech picker keeps series
 * rows out.
 *
 * `buildPathViewModel`'s unit tests hand it `series` and `status` directly, so
 * a loader that dropped either (hard-coding `series: null` or
 * `status: "current"`) would pass every one of them. Only a round trip through
 * `pathwaysForPerson` / `pathwaysByMember` can see that.
 *
 * The two loader paths use per-run course codes, so nothing collides with the
 * suites that share the real codes. The picker is allowlisted to the eleven
 * real codes, so it reuses (or creates) the real 8704 row and adds only
 * per-run project names to it, deleting exactly what it created.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	pathEnrollments,
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
} from "#/db/schema";
import type { CatalogPath, PathwaysSeries } from "#/lib/pathways-catalog";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { pathwaysForPerson, pathwaysByMember } = await import(
	"./pathways-read-logic"
);
const { listProjectOptions, resolveProjectDisplay } = await import(
	"./project-picker-logic"
);

const TAG = randomUUID().slice(0, 8);
const CURRENT_CODE = `9704-${TAG}`;
const LEGACY_CODE = `9709-${TAG}`;
const PICKER_CODE = "8704"; // a real, allowlisted current path
const n = (name: string) => `${name} ${TAG}`;

let club: SeededClub;
const createdPathIds: string[] = [];
const createdProjectIds: string[] = [];
let pickerOrdinaryId: string;
let pickerSeriesId: string;

async function addPath(
	courseCode: string,
	status: CatalogPath["status"],
): Promise<string> {
	const [p] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode, name: n("Path"), status })
		.returning({ id: pathwaysPaths.id });
	createdPathIds.push(p.id);
	return p.id;
}

async function addProject(
	pathId: string,
	level: number,
	name: string,
	isRequired: boolean,
	series: PathwaysSeries | null = null,
): Promise<string> {
	const [row] = await testDb
		.insert(pathwaysProjects)
		.values({ pathId, level, name, isRequired, series })
		.returning({ id: pathwaysProjects.id });
	createdProjectIds.push(row.id);
	return row.id;
}

describe.skipIf(!hasTestDb)("#921 series/status wiring", () => {
	beforeAll(async () => {
		club = await seedClub();

		// A current path whose only working level is 4: one required project,
		// one elective, one series presentation, and a 1-elective minimum.
		const currentId = await addPath(CURRENT_CODE, "current");
		await addProject(currentId, 4, n("Required"), true);
		await addProject(currentId, 4, n("Elective"), false);
		await addProject(currentId, 4, n("Series"), false, "successful_club");
		await testDb
			.insert(pathwaysPathLevels)
			.values({ pathId: currentId, level: 4, minReqElectives: 1 });

		const legacyId = await addPath(LEGACY_CODE, "legacy");
		await addProject(legacyId, 1, n("Legacy Project"), true);

		// The real 8704 for the picker: reuse if another run left it, else create.
		const [existing] = await testDb
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, PICKER_CODE));
		const pickerPathId =
			existing?.id ?? (await addPath(PICKER_CODE, "current"));
		pickerOrdinaryId = await addProject(pickerPathId, 1, n("Pickable"), true);
		pickerSeriesId = await addProject(
			pickerPathId,
			4,
			n("Picker Series"),
			false,
			"better_speaker",
		);

		await testDb.insert(pathEnrollments).values(
			[currentId, legacyId, pickerPathId].map((pathId) => ({
				personId: club.personId,
				pathId,
			})),
		);
	});

	afterAll(async () => {
		await testDb
			.delete(pathEnrollments)
			.where(eq(pathEnrollments.personId, club.personId));
		if (createdProjectIds.length > 0) {
			await testDb
				.delete(pathwaysProjects)
				.where(inArray(pathwaysProjects.id, createdProjectIds));
		}
		if (createdPathIds.length > 0) {
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, createdPathIds));
		}
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	const loaders = {
		pathwaysForPerson: () => pathwaysForPerson(club.personId),
		pathwaysByMember: async () =>
			(await pathwaysByMember(club.clubId)).get(club.memberId) ?? [],
	};

	for (const [label, load] of Object.entries(loaders)) {
		describe(label, () => {
			it("reads series from the DB: the series row is not offered as an elective", async () => {
				const vm = (await load()).find((p) => p.courseCode === CURRENT_CODE);
				expect(vm?.workingLevel).toBe(4);
				expect(vm?.upNextElectives?.options.map((o) => o.name)).toEqual([
					n("Elective"),
				]);
				expect(vm?.upNext.map((p) => p.name)).toEqual([n("Required")]);
				expect(vm?.levels.find((l) => l.level === 4)?.total).toBe(2);
			});

			it("reads status from the DB, legacy and current", async () => {
				const vms = await load();
				expect(vms.find((p) => p.courseCode === LEGACY_CODE)?.status).toBe(
					"legacy",
				);
				expect(vms.find((p) => p.courseCode === CURRENT_CODE)?.status).toBe(
					"current",
				);
			});
		});
	}

	describe("speech project picker", () => {
		it("lists the ordinary project and not the series row", async () => {
			const paths = await listProjectOptions(club.personId, {
				includeProgress: false,
			});
			const ids = (
				paths.find((p) => p.courseCode === PICKER_CODE)?.projects ?? []
			).map((p) => p.id);
			expect(ids).toContain(pickerOrdinaryId);
			expect(ids).not.toContain(pickerSeriesId);
		});

		it("refuses a series row's id on the write path", async () => {
			await expect(
				resolveProjectDisplay(pickerOrdinaryId),
			).resolves.toMatchObject({ projectName: n("Pickable") });
			await expect(resolveProjectDisplay(pickerSeriesId)).rejects.toThrow(
				"no longer exists",
			);
		});
	});
});

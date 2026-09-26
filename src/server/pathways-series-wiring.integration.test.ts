/**
 * The DB half of #921/#922: `series` and `status` actually reach the read model
 * from the database, through BOTH loaders; the speech picker offers series rows
 * and counts a mark as completion; a picked series row is written with its
 * series label; and free-text matching never links to a series row.
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
	projectCompletionMarks,
	speeches,
} from "#/db/schema";
import type { CatalogPath, PathwaysSeries } from "#/lib/pathways-catalog";
import { SPEAKER_LIMITS } from "#/lib/speaker-limits";
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
const { resolveSpeechProjects } = await import(
	"./pathways-project-match-logic"
);

const TAG = randomUUID().slice(0, 8);
const CURRENT_CODE = `9704-${TAG}`;
const LEGACY_CODE = `9709-${TAG}`;
const MATCH_CODE = `9711-${TAG}`;
const PICKER_CODE = "8704"; // a real, allowlisted current path
const n = (name: string) => `${name} ${TAG}`;

let club: SeededClub;
const createdPathIds: string[] = [];
const createdProjectIds: string[] = [];
const createdSpeechIds: string[] = [];
let pickerOrdinaryId: string;
let pickerSeriesId: string;
let pickerLongSeriesId: string;
let pickerEnrollmentId: string;
let matchOrdinaryId: string;
let matchCollidingOrdinaryId: string;

async function addPath(
	courseCode: string,
	status: CatalogPath["status"],
	name = n("Path"),
): Promise<string> {
	const [p] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode, name, status })
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

describe.skipIf(!hasTestDb)("#921/#922 series wiring", () => {
	beforeAll(async () => {
		club = await seedClub();

		// A current path whose only working level is 4: one required project,
		// one elective, one Successful Club presentation, and a 1-elective
		// minimum. No Better Speaker row, so that series is not counted.
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
		pickerLongSeriesId = await addProject(
			pickerPathId,
			4,
			n("L".repeat(SPEAKER_LIMITS.projectName)),
			false,
			"better_speaker",
		);

		// Free-text matching: a uniquely NAMED path (the matcher looks paths up
		// by name, globally), with an ordinary project and a series title that
		// shares an ordinary project's name, as "Impromptu Speaking" can.
		const matchId = await addPath(MATCH_CODE, "current", n("Match Path"));
		matchOrdinaryId = await addProject(matchId, 2, n("Ordinary"), true);
		matchCollidingOrdinaryId = await addProject(
			matchId,
			2,
			n("Impromptu Speaking"),
			false,
		);
		await addProject(
			matchId,
			4,
			n("Impromptu Speaking"),
			false,
			"better_speaker",
		);
		await addProject(matchId, 5, n("Mentoring"), false, "successful_club");

		const enrolled = await testDb
			.insert(pathEnrollments)
			.values(
				[currentId, legacyId, pickerPathId].map((pathId) => ({
					personId: club.personId,
					pathId,
				})),
			)
			.returning({ id: pathEnrollments.id, pathId: pathEnrollments.pathId });
		pickerEnrollmentId = enrolled.find((e) => e.pathId === pickerPathId)
			?.id as string;
		await testDb
			.insert(projectCompletionMarks)
			.values({ enrollmentId: pickerEnrollmentId, projectId: pickerSeriesId });
	});

	afterAll(async () => {
		if (createdSpeechIds.length > 0) {
			await testDb
				.delete(speeches)
				.where(inArray(speeches.id, createdSpeechIds));
		}
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
			it("reads series from the DB: offered as a series, not an elective, and counted", async () => {
				const vm = (await load()).find((p) => p.courseCode === CURRENT_CODE);
				expect(vm?.workingLevel).toBe(4);
				expect(vm?.upNextElectives?.options.map((o) => o.name)).toEqual([
					n("Elective"),
				]);
				expect(vm?.upNext.map((p) => p.name)).toEqual([n("Required")]);
				expect(
					vm?.upNextSeries.map((g) => [g.series, g.options.map((o) => o.name)]),
				).toEqual([["successful_club", [n("Series")]]]);
				// required + 1 elective + the one series with a row at this level.
				expect(vm?.levels.find((l) => l.level === 4)?.total).toBe(3);
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
		const pickerProjects = async (includeProgress: boolean) =>
			(await listProjectOptions(club.personId, { includeProgress })).find(
				(p) => p.courseCode === PICKER_CODE,
			)?.projects ?? [];

		it("lists the ordinary project and the series row, with its series", async () => {
			const projects = await pickerProjects(false);
			const byId = new Map(projects.map((p) => [p.id, p]));
			expect(byId.get(pickerOrdinaryId)?.series).toBeNull();
			expect(byId.get(pickerSeriesId)?.series).toBe("better_speaker");
		});

		it("reports a marked series title complete under includeProgress", async () => {
			const projects = await pickerProjects(true);
			const byId = new Map(projects.map((p) => [p.id, p]));
			expect(byId.get(pickerSeriesId)?.complete).toBe(true);
			expect(byId.get(pickerOrdinaryId)?.complete).toBe(false);
		});

		it("reports nothing complete without includeProgress, marked or not", async () => {
			const projects = await pickerProjects(false);
			expect(projects.length).toBeGreaterThan(0);
			expect(projects.filter((p) => p.complete)).toEqual([]);
		});

		it("writes a series row with its series label in front", async () => {
			await expect(resolveProjectDisplay(pickerSeriesId)).resolves.toEqual({
				pathwayPath: expect.any(String),
				projectName: `Better Speaker Series: ${n("Picker Series")}`,
				projectLevel: "Level 4",
			});
		});

		it("caps the prefixed series name, keeping the prefix", async () => {
			const { projectName } = await resolveProjectDisplay(pickerLongSeriesId);
			expect([...projectName]).toHaveLength(SPEAKER_LIMITS.projectName);
			expect(projectName.startsWith("Better Speaker Series: L")).toBe(true);
		});

		it("writes a non-series row's bare name, unchanged", async () => {
			await expect(
				resolveProjectDisplay(pickerOrdinaryId),
			).resolves.toMatchObject({
				projectName: n("Pickable"),
				projectLevel: "Level 1",
			});
		});
	});

	describe("free-text matching", () => {
		const speech = async (projectName: string) => {
			const id = randomUUID();
			await testDb.insert(speeches).values({
				id,
				personId: club.personId,
				title: "A speech",
				pathwayPath: n("Match Path"),
				projectName,
			});
			createdSpeechIds.push(id);
			return id;
		};
		const linked = async (id: string) =>
			(
				await testDb
					.select({ projectId: speeches.projectId })
					.from(speeches)
					.where(eq(speeches.id, id))
			)[0]?.projectId ?? null;

		it("never links a typed title to a series row, and ignores series rows when counting matches", async () => {
			const ordinary = await speech(n("Ordinary"));
			const seriesOnly = await speech(n("mentoring").toUpperCase());
			const colliding = await speech(n("Impromptu Speaking"));
			// Scoped to this suite's speeches: an unscoped run links other
			// suites' fixtures too, racing `pathways-project-match`'s count.
			// The reverse race (that suite's unscoped run linking these first) is
			// why only the resulting LINKS are asserted, never the counts: the
			// matcher is deterministic, so either run leaves the same links.
			await resolveSpeechProjects({
				speechIds: [ordinary, seriesOnly, colliding],
			});
			expect(await linked(ordinary)).toBe(matchOrdinaryId);
			expect(await linked(seriesOnly)).toBeNull();
			// Without the series filter this is two matches and stays unlinked.
			expect(await linked(colliding)).toBe(matchCollidingOrdinaryId);
		});
	});
});

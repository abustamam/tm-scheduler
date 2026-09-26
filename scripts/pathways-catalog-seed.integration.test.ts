/**
 * The seed writes Education Series rows (#921), idempotently, and a Base Camp
 * `/detail` sync leaves them alone.
 *
 * Seeds the REAL catalog, but under per-run course codes (`8711-<tag>`):
 * vitest runs files in parallel against one shared `tm_test`, and three other
 * suites create or reuse the real `8701` / `8707` rows. Only the course code is
 * changed, so every project row, series and level is exactly what production
 * gets. Cleanup deletes only the tagged paths (projects and levels cascade).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pathwaysPaths, pathwaysProjects } from "#/db/schema";
import type { ParsedDetail } from "#/lib/basecamp-detail";
import { type CatalogPath, PATHWAYS_CATALOG } from "#/lib/pathways-catalog";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { seedPathwaysCatalog } = await import("./pathways-catalog-seed");
const { reconcileCatalog } = await import(
	"#/server/pathways-detail-logic"
);

const TAG = randomUUID().slice(0, 8);
const tagged = (code: string) => `${code}-${TAG}`;
const CATALOG: CatalogPath[] = PATHWAYS_CATALOG.map((p) => ({
	...p,
	courseCode: tagged(p.courseCode),
}));
const CODES = CATALOG.map((p) => p.courseCode);

async function seriesRows(courseCode: string) {
	return testDb
		.select({
			id: pathwaysProjects.id,
			level: pathwaysProjects.level,
			name: pathwaysProjects.name,
			isRequired: pathwaysProjects.isRequired,
			series: pathwaysProjects.series,
			bcmBlockId: pathwaysProjects.bcmBlockId,
		})
		.from(pathwaysProjects)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysProjects.pathId))
		.where(
			and(
				eq(pathwaysPaths.courseCode, courseCode),
				isNotNull(pathwaysProjects.series),
			),
		)
		.orderBy(asc(pathwaysProjects.id));
}

async function projectCount(): Promise<number> {
	const rows = await testDb
		.select({ id: pathwaysProjects.id })
		.from(pathwaysProjects)
		.innerJoin(pathwaysPaths, eq(pathwaysPaths.id, pathwaysProjects.pathId))
		.where(inArray(pathwaysPaths.courseCode, CODES));
	return rows.length;
}

describe.skipIf(!hasTestDb)("seedPathwaysCatalog: Education Series (#921)", () => {
	beforeAll(async () => {
		await seedPathwaysCatalog(CATALOG);
	});
	afterAll(async () => {
		await testDb
			.delete(pathwaysPaths)
			.where(inArray(pathwaysPaths.courseCode, CODES));
	});

	it("writes 14 + 14 series rows per current path and none per legacy path", async () => {
		for (const path of CATALOG) {
			const rows = await seriesRows(path.courseCode);
			const count = (level: number, series: string) =>
				rows.filter((r) => r.level === level && r.series === series).length;
			if (path.status === "legacy") {
				expect(rows, path.courseCode).toEqual([]);
				continue;
			}
			expect(
				{
					l4Club: count(4, "successful_club"),
					l4Speaker: count(4, "better_speaker"),
					l5Club: count(5, "successful_club"),
					l5Leadership: count(5, "leadership_excellence"),
					total: rows.length,
				},
				path.courseCode,
			).toEqual({
				l4Club: 4,
				l4Speaker: 10,
				l5Club: 3,
				l5Leadership: 11,
				total: 28,
			});
			expect(rows.every((r) => r.isRequired === false)).toBe(true);
			expect(rows.every((r) => r.bcmBlockId === null)).toBe(true);
		}
	});

	it("creates nothing on a second run", async () => {
		const before = await projectCount();
		const seriesBefore = await seriesRows(tagged("8711"));
		await seedPathwaysCatalog(CATALOG);
		expect(await projectCount()).toBe(before);
		expect(await seriesRows(tagged("8711"))).toEqual(seriesBefore);
	});

	// The conflict branch, not the insert: rows that already exist with the
	// wrong classification (a series row seeded before #921 as a plain row, and
	// the reverse) must be corrected by a re-seed, or `series` in the upsert's
	// `set` is decoration.
	it("re-classifies existing rows on re-seed, in both directions", async () => {
		const code = tagged("8711");
		const [path] = await testDb
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, code));
		const rowAt = (level: number, name: string) =>
			and(
				eq(pathwaysProjects.pathId, path.id),
				eq(pathwaysProjects.level, level),
				eq(pathwaysProjects.name, name),
			);
		const seriesOf = async (level: number, name: string) => {
			const [row] = await testDb
				.select({ series: pathwaysProjects.series })
				.from(pathwaysProjects)
				.where(rowAt(level, name));
			return row?.series;
		};

		await testDb
			.update(pathwaysProjects)
			.set({ series: null })
			.where(rowAt(4, "Finding New Members"));
		await testDb
			.update(pathwaysProjects)
			.set({ series: "better_speaker" })
			.where(rowAt(4, "Create a Podcast"));
		expect(await seriesOf(4, "Finding New Members")).toBeNull();
		expect(await seriesOf(4, "Create a Podcast")).toBe("better_speaker");

		await seedPathwaysCatalog(CATALOG);

		expect(await seriesOf(4, "Finding New Members")).toBe("successful_club");
		expect(await seriesOf(4, "Create a Podcast")).toBeNull();
	});

	it("leaves every series row untouched through a /detail reconcile", async () => {
		const code = tagged("8711");
		const humor = CATALOG.find((p) => p.courseCode === code);
		if (!humor) throw new Error("8711 missing from the catalog");
		const before = await seriesRows(code);
		expect(before).toHaveLength(28);

		// What Base Camp really returns for Levels 4/5: the required projects and
		// the elective a member chose, each with a block id. Never a series title.
		const ordinary = humor.projects.filter(
			(p) => (p.level === 4 || p.level === 5) && p.series === undefined,
		);
		const required = ordinary.filter((p) => p.isRequired);
		const elective = ordinary.find((p) => !p.isRequired && p.level === 4);
		if (!elective) throw new Error("no Level 4 elective on 8711");
		const detail: ParsedDetail = {
			basecampUserId: `u-${TAG}`,
			courseCode: code,
			levels: [
				{ level: 4, minReqElectives: 1 },
				{ level: 5, minReqElectives: 1 },
			],
			projects: [...required, elective].map((p, i) => ({
				blockId: `b-${TAG}-${i}`,
				name: p.name,
				level: p.level,
				isRequired: p.isRequired,
				complete: true,
				speechTitle: null,
				speechDate: null,
			})),
		};

		const res = await reconcileCatalog([detail]);
		// The ordinary rows matched and were stamped, so reconcile really ran.
		expect(res.projectsStamped).toBe(required.length + 1);
		expect(res.projectsDerived).toBe(0);

		expect(await seriesRows(code)).toEqual(before);
	});
});

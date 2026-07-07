/**
 * DB logic for the Base Camp /detail sync (spec 2026-07-07). Two responsibilities:
 *  - reconcileCatalog: stamp bcm_block_id onto matched catalog rows, derive
 *    required projects we didn't seed, report unmatched electives, upsert
 *    pathways_path_levels. Upsert-in-place so speeches.project_id FKs survive.
 *  - syncClubDetail (Task 4): resolve enrollments + replace-per-enrollment the
 *    bcm_project_progress mirror.
 *
 * A `-logic.ts` so `#/db` never leaks into the client bundle (server-modules
 * guard). Never imported by client code.
 */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
} from "#/db/schema";
import type { ParsedDetail } from "#/lib/basecamp-detail";

export interface UnmatchedElective {
	courseCode: string;
	name: string;
	level: number;
}

export interface CatalogReconResult {
	projectsStamped: number;
	projectsDerived: number;
	unmatchedElectives: UnmatchedElective[];
	// blockId → catalog projectId, for building the per-member mirror rows.
	projectIdByBlockId: Map<string, string>;
}

/** courseCode → pathId, resolving each code once. Unknown codes are skipped. */
async function resolvePathIds(
	details: ParsedDetail[],
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const code of new Set(details.map((d) => d.courseCode))) {
		const [row] = await db
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, code));
		if (row) map.set(code, row.id);
	}
	return map;
}

export async function reconcileCatalog(
	details: ParsedDetail[],
): Promise<CatalogReconResult> {
	const res: CatalogReconResult = {
		projectsStamped: 0,
		projectsDerived: 0,
		unmatchedElectives: [],
		projectIdByBlockId: new Map(),
	};
	const pathIds = await resolvePathIds(details);

	for (const detail of details) {
		const pathId = pathIds.get(detail.courseCode);
		if (!pathId) continue; // path not synced (summary handles path creation)

		// Upsert per-level chapter facts.
		for (const lvl of detail.levels) {
			await db
				.insert(pathwaysPathLevels)
				.values({
					pathId,
					level: lvl.level,
					minReqElectives: lvl.minReqElectives,
				})
				.onConflictDoUpdate({
					target: [pathwaysPathLevels.pathId, pathwaysPathLevels.level],
					set: { minReqElectives: lvl.minReqElectives },
				});
		}

		for (const proj of detail.projects) {
			// 1) Match by durable block id (handles renames → same row).
			const [byBlock] = await db
				.select({ id: pathwaysProjects.id, name: pathwaysProjects.name })
				.from(pathwaysProjects)
				.where(eq(pathwaysProjects.bcmBlockId, proj.blockId));
			if (byBlock) {
				if (byBlock.name !== proj.name) {
					await db
						.update(pathwaysProjects)
						.set({ name: proj.name })
						.where(eq(pathwaysProjects.id, byBlock.id));
				}
				res.projectIdByBlockId.set(proj.blockId, byBlock.id);
				continue;
			}

			// 2) Match an unstamped hand-seeded row by (path, level, name) → stamp it.
			const [byName] = await db
				.select({ id: pathwaysProjects.id })
				.from(pathwaysProjects)
				.where(
					and(
						eq(pathwaysProjects.pathId, pathId),
						eq(pathwaysProjects.level, proj.level),
						eq(pathwaysProjects.name, proj.name),
					),
				);
			if (byName) {
				await db
					.update(pathwaysProjects)
					.set({ bcmBlockId: proj.blockId })
					.where(eq(pathwaysProjects.id, byName.id));
				res.projectsStamped += 1;
				res.projectIdByBlockId.set(proj.blockId, byName.id);
				continue;
			}

			// 3) No catalog match. Derive required projects; report electives.
			if (proj.isRequired) {
				const [created] = await db
					.insert(pathwaysProjects)
					.values({
						pathId,
						level: proj.level,
						name: proj.name,
						isRequired: true,
						bcmBlockId: proj.blockId,
					})
					.returning({ id: pathwaysProjects.id });
				res.projectsDerived += 1;
				res.projectIdByBlockId.set(proj.blockId, created.id);
			} else {
				res.unmatchedElectives.push({
					courseCode: detail.courseCode,
					name: proj.name,
					level: proj.level,
				});
			}
		}
	}

	return res;
}

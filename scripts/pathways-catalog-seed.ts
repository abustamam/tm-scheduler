/**
 * Upsert the Pathways project catalog (`src/lib/pathways-catalog.ts`, #101) into
 * `pathways_paths` + `pathways_projects` + `pathways_path_levels`.
 *
 * Side-effect free on import — the CLI wrapper is `seed-pathways-catalog.ts` and
 * the deploy-time runner is `seed-catalog.ts`. Both call this; neither duplicates
 * it. Idempotent: safe to re-run, and #416 runs it on every container boot.
 *
 * NEVER DELETES, and must not start. `speeches.project_id` is
 * `ON DELETE SET NULL`, so removing a catalog row silently unlinks every speech
 * a member ever recorded against that project — real history loss. A project
 * dropped from the catalog therefore lingers in the database by design;
 * `scripts/audit-pathways-catalog.ts` is what surfaces those, and the fix if it
 * ever matters is a `retired_at` flag, not a delete.
 */
import { db } from "#/db";
import {
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
} from "#/db/schema";
import { PATHWAYS_CATALOG } from "#/lib/pathways-catalog";

export interface SeedResult {
	pathsUpserted: number;
	projectsUpserted: number;
	levelsInserted: number;
}

export async function seedPathwaysCatalog(): Promise<SeedResult> {
	let pathsUpserted = 0;
	let projectsUpserted = 0;
	let levelsInserted = 0;

	for (const [pathIndex, path] of PATHWAYS_CATALOG.entries()) {
		const [inserted] = await db
			.insert(pathwaysPaths)
			.values({
				courseCode: path.courseCode,
				name: path.name,
				status: path.status,
				sortOrder: pathIndex,
			})
			.onConflictDoUpdate({
				target: pathwaysPaths.courseCode,
				set: { name: path.name, status: path.status, sortOrder: pathIndex },
			})
			.returning({ id: pathwaysPaths.id });
		if (!inserted) throw new Error(`Failed to upsert path ${path.courseCode}`);
		const pathId = inserted.id;
		pathsUpserted++;

		for (const [projectIndex, project] of path.projects.entries()) {
			await db
				.insert(pathwaysProjects)
				.values({
					pathId,
					level: project.level,
					name: project.name,
					isRequired: project.isRequired,
					sortOrder: projectIndex,
				})
				.onConflictDoUpdate({
					target: [
						pathwaysProjects.pathId,
						pathwaysProjects.level,
						pathwaysProjects.name,
					],
					set: { isRequired: project.isRequired, sortOrder: projectIndex },
				});
			projectsUpserted++;
		}

		// `min_req_electives` — until #412 this table was written ONLY by
		// `reconcileCatalog` from a Base Camp sync. A never-synced club had no row,
		// so `pathways-read-logic.ts` fell back to `minReq = 0`, `chooseCount` came
		// out 0, and the entire "choose N electives" section silently vanished from
		// levels 3–5. No error, no empty state, just absence.
		//
		// DO NOTHING on conflict, deliberately — unlike the path and project
		// upserts above. Base Camp is authoritative for this number: if it ever
		// disagrees with our constant then either TI changed the requirement or we
		// typed it wrong, and Base Camp is right either way. The seed only fills
		// the gap for paths Base Camp has never spoken about.
		for (const level of path.levels) {
			const rows = await db
				.insert(pathwaysPathLevels)
				.values({
					pathId,
					level: level.level,
					minReqElectives: level.minReqElectives,
				})
				.onConflictDoNothing()
				.returning({ id: pathwaysPathLevels.id });
			if (rows.length > 0) levelsInserted++;
		}
	}

	return { pathsUpserted, projectsUpserted, levelsInserted };
}

/**
 * Resolves free-text speeches to catalog projects (Phase 2 / #101).
 *
 * A speech's `pathway_path` / `project_name` are free text (captured before
 * the catalog existed); this backfills `speeches.project_id` by matching those
 * free-text fields against the seeded catalog (`pathways_paths` /
 * `pathways_projects`) case-insensitively. Only speeches with `project_id IS
 * NULL` and a non-empty `project_name` are considered — already-linked
 * speeches are left untouched. A speech resolves only when the path name
 * matches exactly one path AND the project name matches exactly one project
 * within that path; anything else (no path, no project, or an ambiguous
 * match) is left null and counted unresolved. Kept in a `-logic.ts` so `#/db`
 * never leaks into the client bundle (server-modules guard).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import { pathwaysPaths, pathwaysProjects, speeches } from "#/db/schema";

export interface ResolveResult {
	resolved: number;
	unresolved: number;
}

export async function resolveSpeechProjects(): Promise<ResolveResult> {
	const result: ResolveResult = { resolved: 0, unresolved: 0 };

	const candidates = await db
		.select({
			id: speeches.id,
			pathwayPath: speeches.pathwayPath,
			projectName: speeches.projectName,
		})
		.from(speeches)
		.where(isNull(speeches.projectId));

	for (const speech of candidates) {
		const projectName = speech.projectName?.trim();
		if (!projectName) continue;

		const pathName = speech.pathwayPath?.trim();
		if (!pathName) {
			result.unresolved += 1;
			continue;
		}

		const paths = await db
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(sql`lower(${pathwaysPaths.name}) = lower(${pathName})`);
		if (paths.length !== 1) {
			result.unresolved += 1;
			continue;
		}
		const pathId = paths[0].id;

		const projects = await db
			.select({ id: pathwaysProjects.id })
			.from(pathwaysProjects)
			.where(
				and(
					eq(pathwaysProjects.pathId, pathId),
					sql`lower(${pathwaysProjects.name}) = lower(${projectName})`,
				),
			);
		if (projects.length !== 1) {
			result.unresolved += 1;
			continue;
		}

		await db
			.update(speeches)
			.set({ projectId: projects[0].id })
			.where(eq(speeches.id, speech.id));
		result.resolved += 1;
	}

	return result;
}

/**
 * One-off seed: upsert the hand-curated Pathways project catalog
 * (`src/lib/pathways-catalog.ts`, #101) into `pathways_paths` +
 * `pathways_projects`.
 *
 * Usage:
 *   bun run scripts/seed-pathways-catalog.ts
 *
 * `pathways_paths` rows may already exist (created by the Phase 1 sync
 * upsert, which sets courseCode + name only) — this seed upserts them
 * (name, status, sortOrder) by courseCode and adds their projects.
 * Idempotent: safe to re-run. Bun auto-loads .env.local for DATABASE_URL.
 */
import { db } from "#/db";
import { pathwaysPaths, pathwaysProjects } from "#/db/schema";
import { PATHWAYS_CATALOG } from "#/lib/pathways-catalog";

async function main() {
	let pathsUpserted = 0;
	let projectsUpserted = 0;

	for (const [pathIndex, path] of PATHWAYS_CATALOG.entries()) {
		const [{ id: pathId }] = await db
			.insert(pathwaysPaths)
			.values({
				courseCode: path.courseCode,
				name: path.name,
				status: path.status,
				sortOrder: pathIndex,
			})
			.onConflictDoUpdate({
				target: pathwaysPaths.courseCode,
				set: {
					name: path.name,
					status: path.status,
					sortOrder: pathIndex,
				},
			})
			.returning({ id: pathwaysPaths.id });
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
					set: {
						isRequired: project.isRequired,
						sortOrder: projectIndex,
					},
				});
			projectsUpserted++;
		}
	}

	console.log(
		`Done. paths upserted: ${pathsUpserted}, projects upserted: ${projectsUpserted}`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

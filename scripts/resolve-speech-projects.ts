/**
 * One-off backfill: resolve existing free-text speeches (pathway_path /
 * project_name) to catalog projects (`speeches.project_id`, Phase 2 / #101).
 *
 * Usage:
 *   bun run scripts/resolve-speech-projects.ts
 *
 * Safe to re-run: only speeches with `project_id IS NULL` are considered, and
 * an already-resolved speech is simply skipped on the next run. Bun
 * auto-loads .env.local for DATABASE_URL.
 */
import { resolveSpeechProjects } from "#/server/pathways-project-match-logic";

async function main() {
	const { resolved, unresolved } = await resolveSpeechProjects();
	console.log(`Done. resolved: ${resolved}, unresolved: ${unresolved}`);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

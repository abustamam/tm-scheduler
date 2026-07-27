/**
 * CLI wrapper around the catalog seed. The work lives in
 * `scripts/pathways-catalog-seed.ts`; the deploy-time runner
 * (`scripts/seed-catalog.ts`, #416) calls the same function.
 *
 * Usage:
 *   bun run scripts/seed-pathways-catalog.ts
 *
 * Idempotent. Bun auto-loads .env.local for DATABASE_URL.
 */
import { seedPathwaysCatalog } from "./pathways-catalog-seed";

async function main() {
	const { pathsUpserted, projectsUpserted, levelsInserted } =
		await seedPathwaysCatalog();
	console.log(
		`Done. paths upserted: ${pathsUpserted}, projects upserted: ${projectsUpserted}, level rows inserted: ${levelsInserted}`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

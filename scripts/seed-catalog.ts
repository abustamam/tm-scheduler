/**
 * Standalone Pathways-catalog seed runner for the production container (#416).
 *
 * Same shape as `scripts/migrate.ts` and for the same reason: the Railway
 * runtime image is `node:22-slim` with only `.output/` — no Bun, no
 * `node_modules` — so this is bundled (deps inlined) to `.output/seed-catalog.mjs`
 * during the build and run from the Dockerfile CMD, after migrations and before
 * the server starts.
 *
 * WHY THIS EXISTS AT ALL. The catalog used to reach a database only when a human
 * remembered to run `bun run scripts/seed-pathways-catalog.ts` against it. That
 * was tolerable while `pathways_projects` was a redundant mirror of data Base
 * Camp supplies anyway — and in fact production was never seeded, which nobody
 * noticed for months. It stops being tolerable under #420, where the catalog
 * becomes the backing store for a project picker: on a club that never syncs,
 * an unseeded table is not a degraded feature, it is an empty one.
 *
 * `pathways_paths` has no `clubId` — the catalog is global — so this is one
 * operation for the whole app, not something each club does.
 *
 * The seed is idempotent (insert … onConflictDoUpdate), so re-running on every
 * boot is a few hundred upserts and safe under multiple replicas. A failure
 * exits non-zero and the deploy fails closed, exactly like a bad migration.
 */
// Makes this a module so top-level `await` is legal. It would normally be
// implied by a static import, but the only import here is deliberately dynamic
// (see below), which doesn't count.
export {};

if (!process.env.DATABASE_URL) {
	console.error("[seed-catalog] DATABASE_URL is not set");
	process.exit(1);
}

// Imported dynamically, AFTER the check above: `#/db` throws at module scope
// when DATABASE_URL is missing, and a static import would hoist that above the
// check and fail with a stack trace instead of one legible line. Matches how
// `scripts/migrate.ts` reports the same condition.
const { seedPathwaysCatalog } = await import("./pathways-catalog-seed");

try {
	const { pathsUpserted, projectsUpserted, levelsInserted } =
		await seedPathwaysCatalog();
	console.log(
		`[seed-catalog] paths ${pathsUpserted}, projects ${projectsUpserted}, new level rows ${levelsInserted}`,
	);
} catch (err) {
	console.error("[seed-catalog] failed:", err);
	process.exitCode = 1;
}

// The drizzle client holds an open pg pool, which would keep the event loop
// alive; the container needs this process to end so the CMD chain continues.
process.exit(process.exitCode ?? 0);

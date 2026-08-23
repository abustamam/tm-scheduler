/**
 * Standalone global-template seed runner for the production container.
 *
 * Same shape as `scripts/migrate.ts` and `scripts/seed-catalog.ts`, and for the
 * same reason: the Railway runtime image is `node:22-slim` with only
 * `.output/` — no Bun, no `node_modules` — so this is bundled (deps inlined) to
 * `.output/seed-templates.mjs` during the build and run from the Dockerfile CMD,
 * after migrations and before the server starts.
 *
 * WHY THIS EXISTS. `meeting_templates` reached a database only when a human
 * remembered to run `bun run seed:templates` against it, and production was
 * never seeded — so "Change meeting type" shipped in v1.21.0.0 offering a club
 * nothing but the empty state, for two releases, and the gap was found only by
 * querying prod by hand. This is the same failure `seed-catalog.ts` was written
 * for one release earlier, which is the argument for wiring a seed into the
 * deploy the first time rather than the second.
 *
 * A SEPARATE ENTRY rather than a line inside `seed-catalog.ts`: that file is the
 * PATHWAYS catalog, and folding an unrelated seed into a name that means
 * something else is how the next person fails to find it.
 *
 * DO NOT rely on `seed-global-templates.ts`'s `import.meta.main` guard here.
 * Bun and Node 24 define `import.meta.main`; this image is Node 22, where it is
 * `undefined` — so a guard-dependent entry point runs in the container, seeds
 * nothing, exits 0, and reads exactly like success. Call the function.
 */
// Makes this a module so the top-level `await` below is legal (TS1375). The
// only other import here is dynamic, which does not count. Same line, same
// reason, as `seed-catalog.ts`.
export {};

if (!process.env.DATABASE_URL) {
	console.error("[seed-templates] DATABASE_URL is not set");
	process.exit(1);
}

// Imported dynamically, AFTER the check above: `#/db` throws at module scope
// when DATABASE_URL is missing, and a static import would hoist that above the
// check and fail with a stack trace instead of one legible line.
const { seedGlobalTemplates } = await import("./seed-global-templates");

try {
	await seedGlobalTemplates();
} catch (err) {
	console.error("[seed-templates] failed:", err);
	process.exitCode = 1;
}

// The drizzle client holds an open pg pool, which would keep the event loop
// alive; the container needs this process to end so the CMD chain continues.
process.exit(process.exitCode ?? 0);

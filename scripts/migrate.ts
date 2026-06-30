/**
 * Standalone migration runner for the production container.
 *
 * The Railway runtime image is `node:22-slim` with only `.output/` — no Bun,
 * no drizzle-kit, no `node_modules`. So we bundle this script (with its
 * drizzle-orm + pg deps inlined) to `.output/migrate.mjs` during the build, copy
 * the `drizzle/` SQL into the image, and run it before the server starts
 * (see Dockerfile `CMD`). Drizzle records applied migrations, so reruns on every
 * container boot are fast no-ops; a failed migration exits non-zero so the
 * deploy fails closed instead of serving a stale schema.
 *
 * Run locally with: `bun run scripts/migrate.ts` (uses `.env.local`).
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
	console.error("[migrate] DATABASE_URL is not set");
	process.exit(1);
}

const pool = new Pool({ connectionString: url });

try {
	const db = drizzle(pool);
	await migrate(db, { migrationsFolder: "./drizzle" });
	console.log("[migrate] migrations applied");
} catch (err) {
	console.error("[migrate] failed:", err);
	process.exitCode = 1;
} finally {
	await pool.end();
}

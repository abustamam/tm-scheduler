/**
 * A worktree's own test database (#980).
 *
 * Every worktree used to run its database-backed suites against the one
 * `tm_test`, so a wave of parallel agents running full suites failed in each
 * other's files. `bun run worktree:setup` now creates a database per worktree
 * and records its URL in `.env.test.local` at the worktree root (gitignored by
 * `*.local`); the vitest setup file reads it back when `TEST_DATABASE_URL` is
 * not exported. `bun run worktree:teardown` drops it again.
 *
 * Only the pure parts live here, so they can be unit-tested and imported by
 * both the vitest setup file and `scripts/worktree-test-db.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The file setup writes, at the worktree root. Ignored by `*.local`. */
export const TEST_DB_FILE = ".env.test.local";

/**
 * Every database setup creates starts with this. It is what lets teardown
 * refuse anything it did not create: `tm_test`, `tm_scheduler`, and the
 * hand-made `tm_test_496`-style leftovers all fail the check.
 */
export const TEST_DB_PREFIX = "tm_test_wt_";

/** First line of the file. Teardown refuses a file without it. */
export const TEST_DB_MARKER =
	"# Written by `bun run worktree:setup` (#980). Dropped by `bun run worktree:teardown`.";

/** The one key the file carries. */
export const TEST_DB_URL_KEY = "TEST_DATABASE_URL";

/**
 * The repository root this module sits in (`src/test/` → two up). The vitest
 * setup reads `.env.test.local` from here; `worktree-test-db.test.ts` pins it
 * to `git rev-parse --show-toplevel`, because a wrong root finds no file and
 * the database-backed suites silently SKIP rather than fail. `__dirname`, not
 * `fileURLToPath(new URL("../..", import.meta.url))`: under the jsdom
 * environment the global `URL` is jsdom's, which Node's `fileURLToPath`
 * refuses ("The URL must be of scheme file"), failing every jsdom suite.
 */
export const REPO_ROOT = resolve(__dirname, "..", "..");

const PG_IDENTIFIER_MAX = 63;
const NAME_PATTERN = /^tm_test_wt_[a-z0-9_]+$/;

/**
 * The database name for a worktree label (its branch, or its absolute path
 * when HEAD is detached). A readable slug — lowercased, every run of
 * non-alphanumerics folded to `_` — then ALWAYS a hash of the raw label. The
 * slug alone collides: `fix/x-12`, `fix-x-12` and `fix_x_12` all fold to
 * `fix_x_12`, and a collision would hand one worktree another's database. The
 * slug is cut short so the whole name stays within Postgres's 63-byte
 * identifier limit, which silently TRUNCATES rather than erroring.
 */
export function testDbNameFor(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!slug) throw new Error(`Cannot derive a database name from "${label}"`);
	const hash = createHash("sha256").update(label).digest("hex").slice(0, 8);
	const room = PG_IDENTIFIER_MAX - TEST_DB_PREFIX.length - hash.length - 1;
	return `${TEST_DB_PREFIX}${slug.slice(0, room).replace(/_+$/, "")}_${hash}`;
}

/** True only for a name `testDbNameFor` could have produced. */
export function isWorktreeTestDbName(name: string): boolean {
	return name.length <= PG_IDENTIFIER_MAX && NAME_PATTERN.test(name);
}

/** `url` with its database swapped for `name`, host and credentials kept. */
export function withDatabase(url: string, name: string): string {
	const u = new URL(url);
	u.pathname = `/${name}`;
	return u.toString();
}

export function formatTestDbFile(url: string): string {
	return `${TEST_DB_MARKER}\n${TEST_DB_URL_KEY}=${url}\n`;
}

export interface WorktreeTestDb {
	url: string;
	name: string;
}

/**
 * Read a file `formatTestDbFile` wrote. Anything else — no marker, no URL, a
 * database name setup could not have created — is `null`, never a guess: the
 * caller that acts on this result is teardown's `DROP DATABASE`.
 */
export function parseTestDbFile(text: string): WorktreeTestDb | null {
	const lines = text.split(/\r?\n/);
	if (lines[0] !== TEST_DB_MARKER) return null;
	const prefix = `${TEST_DB_URL_KEY}=`;
	const line = lines.find((l) => l.startsWith(prefix));
	if (!line) return null;
	const url = line.slice(prefix.length).trim();
	let name: string;
	try {
		name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
	} catch {
		return null;
	}
	if (!isWorktreeTestDbName(name)) return null;
	return { url, name };
}

export function readTestDbFile(root: string): WorktreeTestDb | null {
	const path = join(root, TEST_DB_FILE);
	if (!existsSync(path)) return null;
	return parseTestDbFile(readFileSync(path, "utf8"));
}

/**
 * Point `env.TEST_DATABASE_URL` at the worktree's database, unless it is
 * already set. An exported value always wins, so CI and a deliberate
 * `TEST_DATABASE_URL=… bun run test` are unchanged; the main checkout has no
 * file, so it keeps whatever it exports (`tm_test`). Returns the URL applied,
 * or `undefined` when nothing changed.
 */
export function applyWorktreeTestDb(
	env: Record<string, string | undefined>,
	root: string = REPO_ROOT,
): string | undefined {
	if (env[TEST_DB_URL_KEY] !== undefined) return undefined;
	const db = readTestDbFile(root);
	if (!db) return undefined;
	env[TEST_DB_URL_KEY] = db.url;
	return db.url;
}

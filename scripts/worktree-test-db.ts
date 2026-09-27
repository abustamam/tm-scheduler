/**
 * Create or drop a worktree's own test database (#980).
 *
 *   bun scripts/worktree-test-db.ts ensure   # called by scripts/setup-worktree.sh
 *   bun scripts/worktree-test-db.ts drop     # called by scripts/teardown-worktree.sh
 *
 * `ensure` is idempotent: it reuses the name already recorded in
 * `.env.test.local` (so a `git branch -m` after setup keeps the same
 * database), creates the database only if it is absent, re-syncs the schema
 * with `db:push --force` as CLAUDE.md prescribes for test databases, and only
 * then writes the file. `drop` acts ONLY on a database named in a file that
 * setup wrote, and only on a `tm_test_wt_` name, so it can never reach
 * `tm_test`, `tm_scheduler` or a hand-made database.
 *
 * The server and credentials are DATABASE_URL's, read from the environment or
 * the worktree's `.env.local`; only the database name changes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "dotenv";
import pg from "pg";
import {
	formatTestDbFile,
	isWorktreeTestDbName,
	readTestDbFile,
	TEST_DB_FILE,
	testDbNameFor,
	withDatabase,
} from "../src/test/worktree-test-db";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
}).trim();

function baseUrl(): string {
	const local = join(root, ".env.local");
	const url =
		process.env.DATABASE_URL ??
		(existsSync(local)
			? parse(readFileSync(local, "utf8")).DATABASE_URL
			: undefined);
	if (!url) throw new Error("DATABASE_URL is not set and .env.local has none");
	return url;
}

function worktreeLabel(): string {
	const branch = execFileSync("git", ["branch", "--show-current"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	return branch || basename(root);
}

async function withAdmin<T>(
	url: string,
	fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
	const client = new pg.Client({
		connectionString: withDatabase(url, "postgres"),
	});
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

async function ensure(): Promise<void> {
	const base = baseUrl();
	const existing = readTestDbFile(root);
	const name = existing?.name ?? testDbNameFor(worktreeLabel());
	// Belt and braces: every name reaching SQL below matches /^tm_test_wt_[a-z0-9_]+$/.
	if (!isWorktreeTestDbName(name)) throw new Error(`Refusing name ${name}`);
	const url = withDatabase(base, name);

	const created = await withAdmin(base, async (c) => {
		const { rowCount } = await c.query(
			"select 1 from pg_database where datname = $1",
			[name],
		);
		if (rowCount) return false;
		await c.query(`create database "${name}"`);
		return true;
	});
	console.log(`  ${created ? "created" : "kept existing"} database ${name}`);

	const push = spawnSync("bun", ["run", "db:push", "--force"], {
		cwd: root,
		env: { ...process.env, DATABASE_URL: url },
		encoding: "utf8",
	});
	if (push.status !== 0) {
		process.stderr.write(push.stdout + push.stderr);
		throw new Error(`db:push against ${name} failed`);
	}
	console.log(`  schema synced (db:push --force)`);

	writeFileSync(join(root, TEST_DB_FILE), formatTestDbFile(url));
	console.log(`  recorded in ${TEST_DB_FILE}`);
}

async function drop(): Promise<void> {
	const path = join(root, TEST_DB_FILE);
	if (!existsSync(path)) {
		console.log(`  no ${TEST_DB_FILE}, so no database to drop`);
		return;
	}
	const db = readTestDbFile(root);
	if (!db) {
		throw new Error(
			`${TEST_DB_FILE} was not written by worktree:setup (or names a database it could not have created); refusing to drop anything`,
		);
	}
	await withAdmin(db.url, (c) =>
		c.query(`drop database if exists "${db.name}" with (force)`),
	);
	rmSync(path);
	console.log(`  dropped database ${db.name}`);
}

const cmd = process.argv[2];
const run = cmd === "ensure" ? ensure : cmd === "drop" ? drop : null;
if (!run) {
	console.error("usage: bun scripts/worktree-test-db.ts ensure|drop");
	process.exit(2);
}
run().catch((err: unknown) => {
	console.error(`  ! ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});

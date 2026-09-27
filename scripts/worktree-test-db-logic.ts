/**
 * Create or drop a worktree's own test database (#980). The CLI is
 * `scripts/worktree-test-db.ts`; this module takes its inputs as arguments so
 * `worktree-test-db.integration.test.ts` can drive it against a throwaway
 * root, label and schema sync.
 *
 * Imports are relative rather than `#/`: `teardown-worktree.test.ts` runs
 * these files inside a fixture repository that has no package.json `imports`
 * map to resolve `#/` against.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The server to create databases on: DATABASE_URL from `env`, else from the
 * worktree's `.env.local`. Only its database name is ever replaced.
 */
export function baseUrl(
	root: string,
	env: Record<string, string | undefined> = process.env,
): string {
	const local = join(root, ".env.local");
	const url =
		env.DATABASE_URL ??
		(existsSync(local)
			? parse(readFileSync(local, "utf8")).DATABASE_URL
			: undefined);
	if (!url) throw new Error("DATABASE_URL is not set and .env.local has none");
	return url;
}

export async function withAdmin<T>(
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

export interface EnsureOptions {
	root: string;
	/** The branch, or the worktree's absolute path when HEAD is detached. */
	label: string;
	base: string;
	/** Bring the database's schema up to date (`db:push --force`). Throws on failure. */
	syncSchema: (url: string) => void;
	log?: (line: string) => void;
}

/**
 * Idempotent. With a record, reuse the name in it — so a `git branch -m` after
 * setup keeps the same database — and re-sync. Without one, create a fresh
 * database and REFUSE one that already exists: an unrecorded database belongs
 * to someone else, and adopting it would let this worktree's teardown
 * force-drop it. The record is written only after the schema sync succeeds;
 * a database created by a failed run is dropped again, so nothing half-made
 * is left for the next run to trip over.
 */
export async function ensureWorktreeTestDb(
	opts: EnsureOptions,
): Promise<{ name: string; url: string; created: boolean }> {
	const log = opts.log ?? (() => {});
	const recorded = readTestDbFile(opts.root);
	if (!recorded && existsSync(join(opts.root, TEST_DB_FILE))) {
		throw new Error(
			`${TEST_DB_FILE} exists but was not written by worktree:setup; move it aside and re-run`,
		);
	}
	const name = recorded?.name ?? testDbNameFor(opts.label);
	// Belt and braces: every name reaching SQL below matches /^tm_test_wt_[a-z0-9_]+$/.
	if (!isWorktreeTestDbName(name)) throw new Error(`Refusing name ${name}`);
	const url = withDatabase(opts.base, name);

	const created = await withAdmin(opts.base, async (c) => {
		const { rowCount } = await c.query(
			"select 1 from pg_database where datname = $1",
			[name],
		);
		if (rowCount) {
			if (!recorded) {
				throw new Error(
					`database ${name} already exists but this worktree has no record of creating it; refusing to adopt it`,
				);
			}
			return false;
		}
		await c.query(`create database "${name}"`);
		return true;
	});
	log(`  ${created ? "created" : "kept existing"} database ${name}`);

	try {
		opts.syncSchema(url);
	} catch (err) {
		if (created) {
			await withAdmin(opts.base, (c) =>
				c.query(`drop database if exists "${name}" with (force)`),
			);
			log(`  dropped ${name} again: its schema sync failed`);
		}
		throw err;
	}
	log("  schema synced (db:push --force)");

	writeFileSync(join(opts.root, TEST_DB_FILE), formatTestDbFile(url));
	log(`  recorded in ${TEST_DB_FILE}`);
	return { name, url, created };
}

/**
 * Drop ONLY the database named in a record setup wrote, and only a
 * `tm_test_wt_` name; then delete the record. No record is a no-op.
 */
export async function dropWorktreeTestDb(
	root: string,
	log: (line: string) => void = () => {},
): Promise<string | null> {
	const path = join(root, TEST_DB_FILE);
	if (!existsSync(path)) {
		log(`  no ${TEST_DB_FILE}, so no database to drop`);
		return null;
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
	log(`  dropped database ${db.name}`);
	return db.name;
}

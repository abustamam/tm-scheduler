/**
 * `ensureWorktreeTestDb` (#980) creates databases and hands their names to
 * teardown's `DROP ... WITH (FORCE)`, so each rule it keeps is asserted
 * against a real server: idempotence, a rename keeping the recorded name, a
 * failed schema sync leaving nothing behind, and refusing to adopt a
 * database it has no record of creating. The schema sync is a stub — the
 * real one is `db:push`, which the CLI supplies — so these run in seconds.
 *
 * Every label carries this run's pid and time, and afterAll drops every name
 * the run could have created, so a crash leaks nothing into the next run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hasTestDb } from "#/test/db";
import {
	parseTestDbFile,
	TEST_DB_FILE,
	testDbNameFor,
} from "#/test/worktree-test-db";
import {
	baseUrl,
	ensureWorktreeTestDb,
	withAdmin,
} from "./worktree-test-db-logic";

describe("baseUrl", () => {
	it("throws when neither the environment nor .env.local has DATABASE_URL", () => {
		const root = mkdtempSync(join(tmpdir(), "wt-base-"));
		try {
			expect(() => baseUrl(root, {})).toThrow(/DATABASE_URL is not set/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers the environment's DATABASE_URL", () => {
		expect(baseUrl("/nonexistent", { DATABASE_URL: "postgresql://x/y" })).toBe(
			"postgresql://x/y",
		);
	});
});

describe.skipIf(!hasTestDb)("ensureWorktreeTestDb", () => {
	const base = process.env.TEST_DATABASE_URL ?? "postgresql://invalid";
	const run = `${process.pid}-${Date.now()}`;
	const labels: string[] = [];
	const roots: string[] = [];

	function fresh(tag: string) {
		const label = `ensure-${tag}-${run}`;
		labels.push(label);
		const root = mkdtempSync(join(tmpdir(), "wt-ensure-"));
		roots.push(root);
		return { label, root, name: testDbNameFor(label) };
	}
	const exists = (name: string) =>
		withAdmin(base, async (c) => {
			const { rowCount } = await c.query(
				"select 1 from pg_database where datname = $1",
				[name],
			);
			return rowCount === 1;
		});
	const noSync = () => {};

	afterAll(async () => {
		await withAdmin(base, async (c) => {
			for (const l of labels) {
				await c.query(
					`drop database if exists "${testDbNameFor(l)}" with (force)`,
				);
			}
		});
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});

	it("creates the database and records it; a second run keeps both", async () => {
		const { label, root, name } = fresh("idem");
		const synced: string[] = [];
		const syncSchema = (url: string) => {
			synced.push(url);
		};

		const first = await ensureWorktreeTestDb({ root, label, base, syncSchema });
		expect(first).toMatchObject({ name, created: true });
		expect(await exists(name)).toBe(true);
		const record = readFileSync(join(root, TEST_DB_FILE), "utf8");
		expect(parseTestDbFile(record)?.name).toBe(name);

		const second = await ensureWorktreeTestDb({
			root,
			label,
			base,
			syncSchema,
		});
		expect(second).toMatchObject({ name, created: false });
		expect(readFileSync(join(root, TEST_DB_FILE), "utf8")).toBe(record);
		// Re-running re-syncs the schema against the same database.
		expect(synced).toEqual([first.url, first.url]);
	});

	it("keeps the recorded database after a branch rename", async () => {
		const { label, root, name } = fresh("rename");
		await ensureWorktreeTestDb({ root, label, base, syncSchema: noSync });

		const renamed = `${label}-renamed`;
		labels.push(renamed);
		const again = await ensureWorktreeTestDb({
			root,
			label: renamed,
			base,
			syncSchema: noSync,
		});
		expect(again).toMatchObject({ name, created: false });
		expect(await exists(testDbNameFor(renamed))).toBe(false);
	});

	it("leaves no record and no database when the schema sync fails", async () => {
		const { label, root, name } = fresh("pushfail");
		await expect(
			ensureWorktreeTestDb({
				root,
				label,
				base,
				syncSchema: () => {
					throw new Error("db:push --force failed");
				},
			}),
		).rejects.toThrow("db:push --force failed");
		expect(existsSync(join(root, TEST_DB_FILE))).toBe(false);
		expect(await exists(name)).toBe(false);

		// So the next run starts clean rather than being refused.
		const retry = await ensureWorktreeTestDb({
			root,
			label,
			base,
			syncSchema: noSync,
		});
		expect(retry).toMatchObject({ name, created: true });
	});

	it("refuses to adopt an existing database it has no record of", async () => {
		const { label, root, name } = fresh("adopt");
		await withAdmin(base, (c) => c.query(`create database "${name}"`));
		let synced = false;

		await expect(
			ensureWorktreeTestDb({
				root,
				label,
				base,
				syncSchema: () => {
					synced = true;
				},
			}),
		).rejects.toThrow(/refusing to adopt/);
		expect(synced).toBe(false);
		expect(existsSync(join(root, TEST_DB_FILE))).toBe(false);
		expect(await exists(name)).toBe(true);
	});
});

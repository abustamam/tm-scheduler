/**
 * `bun run worktree:teardown` (#980) removes a worktree and DROPS A DATABASE,
 * so each case drives the real script against a throwaway git repository and
 * asserts what it must refuse: the main checkout, a dirty worktree (before
 * anything is dropped), and a record setup did not write. The database-backed
 * case creates a real `tm_test_wt_…` database on TEST_DATABASE_URL's server,
 * tears down, and asserts that one database is gone and `tm_test` is not.
 *
 * The fixture repo carries copies of the TypeScript files the script runs
 * and a symlink to this checkout's node_modules, so `bun` resolves `pg`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasTestDb } from "#/test/db";
import {
	formatTestDbFile,
	TEST_DB_FILE,
	withDatabase,
} from "#/test/worktree-test-db";
import { withAdmin } from "./worktree-test-db-logic";

const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/teardown-worktree.sh");
const COPIED = [
	"scripts/teardown-worktree.sh",
	"scripts/worktree-test-db.ts",
	"scripts/worktree-test-db-logic.ts",
	"src/test/worktree-test-db.ts",
];

let base: string;
let main: string;

function git(cwd: string, ...args: string[]) {
	return execFileSync(
		"git",
		[
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"-c",
			"core.hooksPath=/dev/null",
			...args,
		],
		{ cwd, encoding: "utf8" },
	);
}

let n = 0;
function addWorktree(): string {
	const dir = join(base, `wt-${n++}`);
	git(main, "worktree", "add", "-q", dir, "-b", `branch-${n}`);
	symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
	return dir;
}

function teardown(cwd: string) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")),
	);
	const r = spawnSync("bash", [SCRIPT], { cwd, env, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "teardown-worktree-"));
	main = join(base, "main");
	mkdirSync(main);
	git(main, "init", "-q", "-b", "main");
	for (const f of COPIED) {
		mkdirSync(join(main, f, ".."), { recursive: true });
		copyFileSync(join(ROOT, f), join(main, f));
	}
	writeFileSync(join(main, ".gitignore"), "node_modules\n*.local\n");
	git(main, "add", "-A");
	git(main, "commit", "-q", "-m", "fixture");
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("scripts/teardown-worktree.sh", () => {
	it("refuses the main checkout", () => {
		const r = teardown(main);
		expect(r.code).toBe(1);
		expect(r.out).toContain("main checkout");
	});

	it("refuses a dirty worktree before dropping anything", () => {
		const wt = addWorktree();
		const record = formatTestDbFile(
			"postgresql://dev:dev@localhost:5432/tm_test_wt_never_touched",
		);
		writeFileSync(join(wt, TEST_DB_FILE), record);
		writeFileSync(join(wt, "uncommitted.txt"), "work in progress\n");

		const r = teardown(wt);
		expect(r.code).toBe(1);
		expect(r.out).toContain("uncommitted changes");
		expect(existsSync(join(wt, "uncommitted.txt"))).toBe(true);
		expect(existsSync(join(wt, TEST_DB_FILE))).toBe(true);
	});

	it("refuses a database record setup did not write, and keeps the worktree", () => {
		const wt = addWorktree();
		writeFileSync(
			join(wt, TEST_DB_FILE),
			"TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test\n",
		);
		const r = teardown(wt);
		expect(r.code).toBe(1);
		expect(r.out).toContain("refusing to drop anything");
		expect(existsSync(wt)).toBe(true);
	});

	it("refuses a locked worktree before dropping anything", () => {
		const wt = addWorktree();
		writeFileSync(
			join(wt, TEST_DB_FILE),
			formatTestDbFile(
				"postgresql://dev:dev@localhost:5432/tm_test_wt_never_touched",
			),
		);
		git(main, "worktree", "lock", wt);
		const r = teardown(wt);
		expect(r.code).toBe(1);
		expect(r.out).toContain("is locked");
		expect(existsSync(join(wt, TEST_DB_FILE))).toBe(true);
		git(main, "worktree", "unlock", wt);
	});

	it("removes a clean worktree that has no test database", () => {
		const wt = addWorktree();
		const r = teardown(wt);
		expect(r.out).toContain("no database to drop");
		expect(r.code).toBe(0);
		expect(existsSync(wt)).toBe(false);
	});

	describe.skipIf(!hasTestDb)("with a real database", () => {
		const server = process.env.TEST_DATABASE_URL ?? "postgresql://invalid";
		const name = `tm_test_wt_teardown_probe_${process.pid}`;
		const exists = (db: string) =>
			withAdmin(server, async (c) => {
				const { rowCount } = await c.query(
					"select 1 from pg_database where datname = $1",
					[db],
				);
				return rowCount === 1;
			});

		afterAll(() =>
			withAdmin(server, (c) => c.query(`drop database if exists "${name}"`)),
		);

		it("drops exactly the recorded database and removes the worktree", async () => {
			await withAdmin(server, (c) => c.query(`create database "${name}"`));

			const wt = addWorktree();
			writeFileSync(
				join(wt, TEST_DB_FILE),
				formatTestDbFile(withDatabase(server, name)),
			);
			const r = teardown(wt);
			expect(r.out).toContain(`dropped database ${name}`);
			expect(r.code).toBe(0);
			expect(existsSync(wt)).toBe(false);
			expect(await exists(name)).toBe(false);
			expect(await exists("tm_test")).toBe(true);
		});
	});
});

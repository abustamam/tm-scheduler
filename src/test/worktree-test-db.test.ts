import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyWorktreeTestDb,
	formatTestDbFile,
	isWorktreeTestDbName,
	parseTestDbFile,
	REPO_ROOT,
	TEST_DB_FILE,
	TEST_DB_MARKER,
	testDbNameFor,
	withDatabase,
} from "./worktree-test-db";

const BASE = "postgresql://dev:dev@localhost:5432/tm_scheduler";

describe("testDbNameFor", () => {
	it("is a readable slug of the branch plus a hash of the raw label", () => {
		expect(testDbNameFor("worktree-test-db-980")).toMatch(
			/^tm_test_wt_worktree_test_db_980_[0-9a-f]{8}$/,
		);
		expect(testDbNameFor("Fix/Dialog.Scroll--619")).toMatch(
			/^tm_test_wt_fix_dialog_scroll_619_[0-9a-f]{8}$/,
		);
	});

	it("gives labels that fold to the same slug different databases", () => {
		const names = ["fix/x-12", "fix-x-12", "fix_x_12"].map(testDbNameFor);
		expect(new Set(names).size).toBe(3);
	});

	it("is stable for one label, so re-running setup finds the same database", () => {
		expect(testDbNameFor("a-branch-1")).toBe(testDbNameFor("a-branch-1"));
	});

	it("stays within Postgres's 63-byte limit, and two long branches sharing a prefix still differ", () => {
		const long = `${"a-very-long-branch-name-".repeat(4)}`;
		const a = testDbNameFor(`${long}617`);
		const b = testDbNameFor(`${long}618`);
		expect(a.length).toBeLessThanOrEqual(63);
		expect(b.length).toBeLessThanOrEqual(63);
		expect(a).not.toBe(b);
		expect(isWorktreeTestDbName(a)).toBe(true);
	});

	it("refuses a label with nothing usable in it", () => {
		expect(() => testDbNameFor("---")).toThrow();
	});
});

describe("isWorktreeTestDbName", () => {
	it.each([
		"tm_test",
		"tm_scheduler",
		"tm_test_496",
		"postgres",
		"tm_test_wt_",
		'tm_test_wt_x"; drop database tm_test; --',
		`tm_test_wt_${"x".repeat(60)}`,
	])("rejects %s", (name) => {
		expect(isWorktreeTestDbName(name)).toBe(false);
	});
});

describe("parseTestDbFile", () => {
	it("round-trips what setup writes", () => {
		const url = withDatabase(BASE, "tm_test_wt_foo_1");
		expect(parseTestDbFile(formatTestDbFile(url))).toEqual({
			url: "postgresql://dev:dev@localhost:5432/tm_test_wt_foo_1",
			name: "tm_test_wt_foo_1",
		});
	});

	it("refuses a file setup did not write (no marker)", () => {
		expect(
			parseTestDbFile(
				"TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_wt_foo\n",
			),
		).toBeNull();
	});

	it.each([
		"tm_test",
		"tm_scheduler",
		"tm_test_496",
	])("refuses a marked file naming %s, so teardown can never drop it", (db) => {
		expect(
			parseTestDbFile(formatTestDbFile(withDatabase(BASE, db))),
		).toBeNull();
	});

	it("refuses a marked file with no URL or a malformed one", () => {
		expect(parseTestDbFile(`${TEST_DB_MARKER}\n`)).toBeNull();
		expect(
			parseTestDbFile(`${TEST_DB_MARKER}\nTEST_DATABASE_URL=not a url\n`),
		).toBeNull();
	});
});

describe("applyWorktreeTestDb", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function rootWith(content?: string): string {
		dir = mkdtempSync(join(tmpdir(), "wt-test-db-"));
		if (content !== undefined) writeFileSync(join(dir, TEST_DB_FILE), content);
		return dir;
	}
	const worktreeUrl = withDatabase(BASE, "tm_test_wt_mine_980");

	it("fills TEST_DATABASE_URL from the worktree's file when unset", () => {
		const env: Record<string, string | undefined> = {};
		expect(
			applyWorktreeTestDb(env, rootWith(formatTestDbFile(worktreeUrl))),
		).toBe(worktreeUrl);
		expect(env.TEST_DATABASE_URL).toBe(worktreeUrl);
	});

	it("leaves an exported TEST_DATABASE_URL alone, so CI and deliberate overrides win", () => {
		const exported = withDatabase(BASE, "tm_test");
		const env: Record<string, string | undefined> = {
			TEST_DATABASE_URL: exported,
		};
		expect(
			applyWorktreeTestDb(env, rootWith(formatTestDbFile(worktreeUrl))),
		).toBeUndefined();
		expect(env.TEST_DATABASE_URL).toBe(exported);
	});

	it("changes nothing with no file, which is the main checkout", () => {
		const env: Record<string, string | undefined> = {};
		expect(applyWorktreeTestDb(env, rootWith())).toBeUndefined();
		expect(env).toEqual({});
	});

	it("ignores a file it cannot trust", () => {
		const env: Record<string, string | undefined> = {};
		applyWorktreeTestDb(env, rootWith(`TEST_DATABASE_URL=${worktreeUrl}\n`));
		expect(env.TEST_DATABASE_URL).toBeUndefined();
	});
});

describe("REPO_ROOT", () => {
	// The vitest setup reads `.env.test.local` from here. A wrong root finds no
	// file, and the database-backed suites SKIP instead of failing.
	it("is the checkout's top level", () => {
		const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: __dirname,
			encoding: "utf8",
		}).trim();
		expect(REPO_ROOT).toBe(top);
		expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true);
	});

	it("is the root the setup file applies, when nothing is exported", () => {
		const env: Record<string, string | undefined> = {};
		const applied = applyWorktreeTestDb(env);
		const recorded = existsSync(join(REPO_ROOT, TEST_DB_FILE));
		// In a bootstrapped worktree this finds the record; in CI and the main
		// checkout there is none. Either way it must agree with the file on disk.
		expect(applied !== undefined).toBe(recorded);
	});
});

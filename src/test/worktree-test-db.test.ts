import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyWorktreeTestDb,
	formatTestDbFile,
	isWorktreeTestDbName,
	parseTestDbFile,
	TEST_DB_FILE,
	TEST_DB_MARKER,
	testDbNameFor,
	withDatabase,
} from "./worktree-test-db";

const BASE = "postgresql://dev:dev@localhost:5432/tm_scheduler";

describe("testDbNameFor", () => {
	it("folds a branch into a prefixed identifier", () => {
		expect(testDbNameFor("worktree-test-db-980")).toBe(
			"tm_test_wt_worktree_test_db_980",
		);
		expect(testDbNameFor("Fix/Dialog.Scroll--619")).toBe(
			"tm_test_wt_fix_dialog_scroll_619",
		);
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

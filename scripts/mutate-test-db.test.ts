/**
 * #1001: `scripts/mutate.sh` defaulted and exported TEST_DATABASE_URL to the
 * shared `tm_test` before vitest started, so `src/test/setup-env.ts` never got
 * to read the worktree's own database out of `.env.test.local`. On #765 that
 * made every mutation baseline read RED (tm_test lacked the branch's column)
 * while the same suite passed under a plain `bunx vitest run`.
 *
 * Each case drives the real script from a throwaway git repository, so its
 * `git rev-parse --show-toplevel` lands there and the `.env.test.local` it
 * reads is the fixture's, never this worktree's. That repository has no vitest
 * config, so no setup file runs and the fixture test sees exactly what the
 * SCRIPT exported: it passes only when TEST_DATABASE_URL equals the URL the
 * case expects. A baseline that passes therefore proves which database the
 * script chose, and the mutation that follows proves the run was real.
 */
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatTestDbFile,
	TEST_DB_FILE,
} from "../src/test/worktree-test-db";

const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/mutate.sh");

const WT_URL =
	"postgresql://dev:dev@127.0.0.1:5433/tm_test_wt_fixture_branch_0123abcd";
const EXPORTED_URL = "postgresql://dev:dev@127.0.0.1:5433/tm_test_exported";
const SHARED_URL = "postgresql://dev:dev@localhost:5432/tm_test";

const TARGET_SRC = "export const one = 1;\n";

let repo: string;

beforeEach(() => {
	repo = realpathSync(mkdtempSync(join(tmpdir(), "mutate-test-db-")));
	spawnSync("git", ["init", "-q"], { cwd: repo });
	symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
	writeFileSync(join(repo, "target.ts"), TARGET_SRC);
	writeFileSync(
		join(repo, "target.test.ts"),
		`import { expect, it } from "vitest";
import { one } from "./target";
it("sees the expected database", () => {
	expect(process.env.TEST_DATABASE_URL).toBe(process.env.EXPECT_DB);
	expect(one).toBe(1);
});
`,
	);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function mutate(opts: { expect: string; exported?: string }) {
	// The outer setup file has already set TEST_DATABASE_URL in this process;
	// drop it so "nothing exported" really is nothing exported. The nested
	// vitest must not believe it is a worker of this one either.
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined || k.startsWith("VITEST")) continue;
		if (k === "TEST_DATABASE_URL" || k.startsWith("npm_")) continue;
		env[k] = v;
	}
	env.EXPECT_DB = opts.expect;
	if (opts.exported !== undefined) env.TEST_DATABASE_URL = opts.exported;
	const r = spawnSync(
		"bash",
		[SCRIPT, "target.ts", "--literal", "= 1", "= 2", "M", "target.test.ts"],
		{ cwd: repo, env, encoding: "utf8", timeout: 90_000 },
	);
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const unchanged = () =>
	expect(readFileSync(join(repo, "target.ts"), "utf8")).toBe(TARGET_SRC);

describe("scripts/mutate.sh test database (#1001)", () => {
	it("uses the worktree's own database from .env.test.local when nothing is exported", () => {
		writeFileSync(join(repo, TEST_DB_FILE), formatTestDbFile(WT_URL));
		const r = mutate({ expect: WT_URL });
		expect(r.out).toContain(
			"baseline: 1 tests pass (test database tm_test_wt_fixture_branch_0123abcd)",
		);
		expect(r.out).toContain("KILLED");
		expect(r.code).toBe(0);
		unchanged();
	}, 120_000);

	it("lets an exported TEST_DATABASE_URL win over .env.test.local", () => {
		writeFileSync(join(repo, TEST_DB_FILE), formatTestDbFile(WT_URL));
		const r = mutate({ expect: EXPORTED_URL, exported: EXPORTED_URL });
		expect(r.out).toContain("(test database tm_test_exported)");
		expect(r.out).toContain("KILLED");
		unchanged();
	}, 120_000);

	it("falls back to the shared tm_test only with no export and no file", () => {
		const r = mutate({ expect: SHARED_URL });
		expect(r.out).toContain("(test database tm_test)");
		expect(r.out).toContain("KILLED");
		unchanged();
	}, 120_000);

	it("names the database in the RED-baseline error", () => {
		writeFileSync(join(repo, TEST_DB_FILE), formatTestDbFile(WT_URL));
		const r = mutate({ expect: "something-else" });
		expect(r.code).not.toBe(0);
		expect(r.out).toContain(
			"baseline is already RED against test database tm_test_wt_fixture_branch_0123abcd",
		);
		unchanged();
	}, 120_000);

	it.each([
		["no marker line", `TEST_DATABASE_URL=${WT_URL}\n`],
		[
			"a database setup could not have created",
			formatTestDbFile(SHARED_URL),
		],
		["no URL line", `${formatTestDbFile(WT_URL).split("\n")[0]}\n`],
	])("refuses an .env.test.local with %s instead of falling back to tm_test", (_, text) => {
		writeFileSync(join(repo, TEST_DB_FILE), text);
		const r = mutate({ expect: SHARED_URL });
		expect(r.code).not.toBe(0);
		expect(r.out).toContain(
			".env.test.local exists but names no worktree test database",
		);
		expect(r.out).not.toContain("baseline:");
		unchanged();
	}, 30_000);
});

// The route hydration gate runs in its own CI job (#1022). Three places have
// to agree for it to run exactly once: `vitest.config.ts` (which files the
// exclude drops, and on which value), `package.json` (which files
// `test:hydration` runs) and `.github/workflows/ci.yml` (which step sets the
// exclude, which job runs the script and counts what it ran). Any one drifting
// can make the gate run NOWHERE with every job green, so this holds the three
// to each other.
//
// The workflow is PARSED, not grepped: a commented-out `run:` line or jq
// condition would satisfy a text match while doing nothing.
//
// js-yaml is not a direct dependency: it is in the tree through xmlbuilder2 and
// hoisted by `bun install`, so it is loaded with `createRequire` and typed here.
// If it ever leaves the tree this file fails to load, loudly, rather than
// passing: add it to devDependencies then.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "#/test/route-hydration";
import {
	EXCLUDE_GATE_ENV,
	excludesHydrationGate,
	HYDRATION_GATE_FILES,
} from "../../vitest.config";

const yaml = createRequire(import.meta.url)("js-yaml") as {
	load(text: string): unknown;
};

interface Step {
	name?: string;
	run?: string;
	env?: Record<string, unknown>;
	if?: unknown;
	"continue-on-error"?: unknown;
	[k: string]: unknown;
}
interface Job {
	env?: Record<string, unknown>;
	services?: Record<string, unknown>;
	steps: Step[];
	[k: string]: unknown;
}
interface Workflow {
	env?: Record<string, unknown>;
	jobs: Record<string, Job>;
}

const wf = yaml.load(
	readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
) as Workflow;
const pkg = JSON.parse(
	readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

/**
 * A `run:` script with its whole-line comments removed. YAML comments are gone
 * once parsed, but inside a block scalar a `#` line is a SHELL (or jq)
 * comment, and would still satisfy a `toContain`.
 */
function code(run: string | undefined): string {
	return (run ?? "")
		.split("\n")
		.filter((l) => !l.trim().startsWith("#"))
		.join("\n")
		.trim();
}

function job(id: string): Job {
	const j = wf.jobs[id];
	if (!j) throw new Error(`ci.yml has no \`${id}\` job`);
	return j;
}

/** The jq conditions the count step must hold, verbatim. */
const COUNT_CONDITIONS = [
	".numTotalTests > 0",
	".numPassedTests == .numTotalTests",
	'select(.title == "hydrates every route without a mismatch" and .status == "passed")',
];

/** The jq conditions the built-bundle count step must hold, verbatim (#1557). */
const BUNDLE_COUNT_CONDITIONS = [
	".numTotalTests == 2",
	".numPassedTests == .numTotalTests",
	'select(.title == "loads every client chunk without a module-evaluation error" and .status == "passed")',
];

describe("route hydration gate CI wiring (#1022)", () => {
	it("the gate files exist", () => {
		for (const f of HYDRATION_GATE_FILES) {
			expect(existsSync(join(REPO_ROOT, f)), f).toBe(true);
		}
	});

	it("test:hydration runs exactly the files the exclude drops", () => {
		const script = pkg.scripts["test:hydration"] ?? "";
		const args = script.split(/\s+/).filter((a) => a.endsWith(".test.ts"));
		expect(args.sort()).toEqual([...HYDRATION_GATE_FILES].sort());
	});

	it('the exclude honours exactly "1" and nothing else', () => {
		expect(excludesHydrationGate({ [EXCLUDE_GATE_ENV]: "1" })).toBe(true);
		for (const v of [undefined, "", "0", "true", "yes", "false", " 1"]) {
			expect(excludesHydrationGate({ [EXCLUDE_GATE_ENV]: v }), String(v)).toBe(
				false,
			);
		}
	});

	it("only check's Test step sets the exclude, at step level, to the value the config honours", () => {
		const test = job("check").steps.find((s) => s.name === "Test");
		expect(code(test?.run)).toBe("bun run test");
		const value = test?.env?.[EXCLUDE_GATE_ENV];
		expect(value).toBe("1");
		expect(excludesHydrationGate({ [EXCLUDE_GATE_ENV]: String(value) })).toBe(
			true,
		);

		// Nowhere else: not workflow-wide, not job-wide, not another step.
		const setters: string[] = [];
		if (wf.env && EXCLUDE_GATE_ENV in wf.env) setters.push("workflow");
		for (const [id, j] of Object.entries(wf.jobs)) {
			if (j.env && EXCLUDE_GATE_ENV in j.env) setters.push(id);
			for (const s of j.steps) {
				if (s.env && EXCLUDE_GATE_ENV in s.env) {
					setters.push(`${id}/${s.name ?? s.run}`);
				}
			}
		}
		expect(setters).toEqual(["check/Test"]);
	});

	it("the hydration job runs the gate against Postgres and cannot be skipped or soft-failed", () => {
		const h = job("hydration");
		expect(h.services?.postgres).toBeDefined();
		expect(h.env?.TEST_DATABASE_URL).toEqual(expect.any(String));
		expect(h.if).toBeUndefined();
		expect(h["continue-on-error"]).toBeUndefined();
		for (const s of h.steps) {
			expect(s.if, `step ${s.name ?? s.run}`).toBeUndefined();
			expect(s["continue-on-error"], `step ${s.name ?? s.run}`).toBeUndefined();
		}

		const runs = h.steps.map((s) => code(s.run));
		const migrate = runs.findIndex((r) => r.includes("bun run db:migrate"));
		const gate = runs.findIndex((r) => r.startsWith("bun run test:hydration "));
		expect(migrate).toBeGreaterThanOrEqual(0);
		expect(gate).toBeGreaterThan(migrate);
		const report = /--outputFile=(\S+)/.exec(runs[gate] ?? "")?.[1];
		expect(report).toBeDefined();
		// Nothing may swallow the gate's own exit code.
		expect(runs[gate]).not.toMatch(/\|\||;|&&/);

		const count = h.steps.find((s) => s.name === "Gate ran (test count)");
		expect(count, "no count step").toBeDefined();
		expect(h.steps.indexOf(count as Step)).toBeGreaterThan(gate);
		const script = code(count?.run);
		for (const c of COUNT_CONDITIONS) expect(script).toContain(c);
		// The conditions are only a check if nothing can route around them: the
		// `jq -e` begins its line (no `true ||` ahead of it), and its failure
		// branch is exactly an error plus `exit 1` (no `|| true` after it).
		const lines = script.split("\n").map((l) => l.trim());
		const open = lines.findIndex((l) => l.startsWith("jq -e"));
		expect(lines[open], "jq -e must start its own line").toBe("jq -e '");
		const close = lines.indexOf(`' ${report} > /dev/null || {`);
		expect(
			close,
			"the jq check must end in `|| {` on its report",
		).toBeGreaterThan(open);
		expect(lines[close + 1]).toMatch(/^echo "::error::/);
		expect(lines.slice(close + 2)).toEqual(["exit 1", "}"]);
	});

	it("the title the count step demands is a real test in the gate", () => {
		const gate = readFileSync(
			join(REPO_ROOT, "src/routes/route-hydration.test.ts"),
			"utf8",
		);
		expect(gate).toContain('it("hydrates every route without a mismatch"');
	});
});

// The built bundle gate (#1557) loads the BUILT client bundle in Chrome. It is
// only a gate if the `check` job runs it after the build, with the env that
// makes a missing build/database/Chrome a failure, and then counts that it ran.
describe("built bundle gate CI wiring (#1557)", () => {
	const steps = () => job("check").steps;
	const idx = (name: string) => steps().findIndex((s) => s.name === name);

	it("runs after Build, with BUILT_BUNDLE_GATE=1, and cannot be skipped or soft-failed", () => {
		const build = steps().findIndex((s) => code(s.run) === "bun run build");
		const gate = idx("Built bundle gate");
		expect(build, "no `bun run build` step").toBeGreaterThanOrEqual(0);
		expect(gate, "no `Built bundle gate` step").toBeGreaterThanOrEqual(0);
		expect(gate, "the gate must run AFTER the build").toBeGreaterThan(build);
		const s = steps()[gate] as Step;
		expect(s.env?.BUILT_BUNDLE_GATE).toBe("1");
		expect(code(s.run)).toMatch(
			/^bunx vitest run src\/test\/built-bundle\.test\.ts /,
		);
		expect(s.if).toBeUndefined();
		expect(s["continue-on-error"]).toBeUndefined();
		expect(code(s.run)).not.toMatch(/\|\||;|&&/);
		expect(code(s.run)).toContain("--outputFile=built-bundle-report.json");
	});

	it("the env var the workflow sets is the one the test reads", () => {
		const test = readFileSync(
			join(REPO_ROOT, "src/test/built-bundle.test.ts"),
			"utf8",
		);
		expect(test).toContain("process.env.BUILT_BUNDLE_GATE");
	});

	it("a count step after the gate fails the job unless exactly the 2 tests ran and passed", () => {
		const gate = idx("Built bundle gate");
		const count = idx("Built bundle gate ran (test count)");
		expect(count, "no count step").toBeGreaterThan(gate);
		const c = steps()[count] as Step;
		expect(c.if).toBeUndefined();
		expect(c["continue-on-error"]).toBeUndefined();
		const script = code(c.run);
		for (const cond of BUNDLE_COUNT_CONDITIONS) {
			expect(script).toContain(cond);
		}
		const lines = script.split("\n").map((l) => l.trim());
		const open = lines.findIndex((l) => l.startsWith("jq -e"));
		expect(lines[open], "jq -e must start its own line").toBe("jq -e '");
		const close = lines.indexOf("' built-bundle-report.json > /dev/null || {");
		expect(close, "the jq check must end in `|| {`").toBeGreaterThan(open);
		expect(lines[close + 1]).toMatch(/^echo "::error::/);
		expect(lines.slice(close + 2)).toEqual(["exit 1", "}"]);
	});

	it("the title the count step demands is a real test in the gate", () => {
		const test = readFileSync(
			join(REPO_ROOT, "src/test/built-bundle.test.ts"),
			"utf8",
		);
		expect(test).toContain(
			'it("loads every client chunk without a module-evaluation error"',
		);
	});
});

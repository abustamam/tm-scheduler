// The route hydration gate runs in its own CI job (#1022). Three places have
// to agree for it to run exactly once: `vitest.config.ts` (which files the
// exclude drops), `package.json` (which files `test:hydration` runs) and
// `.github/workflows/ci.yml` (which step sets the exclude, which job runs the
// script and counts what it ran). Any one drifting can make the gate run
// NOWHERE with every job green, so this holds the three to each other.
//
// Read as text, not as YAML: the repo has no YAML parser and the shape pinned
// here is small. Jobs are split on their two-space-indented `name:` lines.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "#/test/route-hydration";
import { HYDRATION_GATE_FILES } from "../../vitest.config";

const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
const pkg = JSON.parse(
	readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

/** Each top-level job's body, keyed by job id. */
function jobs(): Record<string, string> {
	const body = ci.slice(ci.indexOf("\njobs:\n"));
	const out: Record<string, string> = {};
	const parts = body.split(/\n {2}([a-z][\w-]*):\n/);
	for (let i = 1; i < parts.length; i += 2) {
		out[parts[i] as string] = parts[i + 1] as string;
	}
	return out;
}

const EXCLUDE = "EXCLUDE_ROUTE_HYDRATION_GATE";

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

	it("only the check job's Test step sets the exclude", () => {
		const j = jobs();
		expect(Object.keys(j)).toEqual(
			expect.arrayContaining(["check", "hydration"]),
		);
		expect(ci.split(`${EXCLUDE}:`).length - 1).toBe(1);
		expect(j.check).toMatch(
			new RegExp(
				`- name: Test\\n\\s+run: bun run test\\n\\s+env:\\n\\s+${EXCLUDE}: "1"`,
			),
		);
		expect(j.hydration).not.toContain(EXCLUDE);
	});

	it("the hydration job runs the gate and fails on a run that ran none of it", () => {
		const h = jobs().hydration ?? "";
		expect(h).toContain("TEST_DATABASE_URL:");
		expect(h).toContain("bun run db:migrate");
		expect(h).toMatch(/run: bun run test:hydration .*--outputFile=(\S+)/);
		expect(h).toContain(".numTotalTests > 0");
		expect(h).toContain(".numPassedTests == .numTotalTests");
		// The title the count step demands is a real test in the gate.
		const title = /select\(\.title == "([^"]+)"/.exec(h)?.[1];
		expect(title).toBeDefined();
		const gate = readFileSync(
			join(REPO_ROOT, "src/routes/route-hydration.test.ts"),
			"utf8",
		);
		expect(gate).toContain(`it("${title}"`);
	});
});

// CI installs ONE Bun version, read from package.json's `packageManager` (#995).
// It used to install `latest`: Bun 1.3.14 and 1.4.2 handle an empty `bun run`
// argument differently, so a PR's tests passed locally and failed in CI, and a
// new Bun release could turn main red with no commit behind it.
//
// Two ways back to that, both silent:
// - a `setup-bun` step that says `bun-version: latest` (or any `bun-version`),
//   which wins over the file;
// - a `packageManager` that setup-bun cannot read (removed, a range, another
//   manager). setup-bun answers an unreadable file with a WARNING and installs
//   `latest`, so the job stays green on whatever Bun shipped that morning.
//
// The workflow is PARSED, as in hydration-gate-ci.guard.test.ts: a
// commented-out line must not satisfy it. js-yaml comes in transitively; see
// that file's header.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const yaml = createRequire(import.meta.url)("js-yaml") as {
	load(text: string): unknown;
};

interface Step {
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
}
interface Job {
	steps: Step[];
}

const wf = yaml.load(
	readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };
const pkg = JSON.parse(
	readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
) as { packageManager?: string };

const isSetupBun = (s: Step) =>
	typeof s.uses === "string" && s.uses.startsWith("oven-sh/setup-bun@");
const runsBun = (s: Step) => /\bbunx?\b/.test(s.run ?? "");

/** The exact version CI installs, or null when the field does not pin one. */
const pinned = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "")?.[1];

describe("Bun version pin (#995)", () => {
	it("package.json pins an exact Bun version in packageManager", () => {
		// An exact x.y.z: setup-bun would resolve a range or tag to whatever is
		// newest, which is `latest` by another name.
		expect(
			pinned,
			`packageManager is ${JSON.stringify(pkg.packageManager)}`,
		).toEqual(expect.any(String));
	});

	it("every setup-bun step reads the version from package.json", () => {
		const steps = Object.entries(wf.jobs).flatMap(([id, job]) =>
			job.steps.filter(isSetupBun).map((s) => ({ id, with: s.with ?? {} })),
		);
		expect(steps.length).toBeGreaterThan(0);
		for (const s of steps) {
			expect(s.with, `job \`${s.id}\``).toEqual(
				expect.objectContaining({ "bun-version-file": "package.json" }),
			);
			// `bun-version` takes precedence over the file, so its mere presence
			// re-opens the hole whatever it says.
			expect(s.with, `job \`${s.id}\``).not.toHaveProperty("bun-version");
		}
	});

	it("every job that runs bun installs it through a setup-bun step", () => {
		for (const [id, job] of Object.entries(wf.jobs)) {
			if (!job.steps.some(runsBun)) continue;
			const setup = job.steps.findIndex(isSetupBun);
			const firstRun = job.steps.findIndex(runsBun);
			expect(
				setup,
				`job \`${id}\` runs bun with no setup-bun step`,
			).toBeGreaterThanOrEqual(0);
			expect(setup, `job \`${id}\` runs bun before installing it`).toBeLessThan(
				firstRun,
			);
		}
	});

	it("the Bun on this machine is the pinned one (enforced in CI)", () => {
		const out = spawnSync("bun", ["--version"], { encoding: "utf8" });
		const local = out.status === 0 ? out.stdout.trim() : null;
		if (process.env.CI) {
			// What setup-bun actually installed: the end-to-end check that the
			// step read the file rather than falling back to `latest`.
			expect(local).toBe(pinned);
			return;
		}
		if (local !== pinned) {
			console.warn(
				`[#995] local Bun is ${local ?? "absent"}, CI installs ${pinned}: ` +
					"a green local run may not predict CI.",
			);
		}
	});
});

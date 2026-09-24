/**
 * `scripts/mutate.sh` is the harness that proves a test can FAIL, so a bug in
 * it reports a coverage gap as covered — the one result nobody re-checks. Each
 * case drives the real script against a throwaway fixture and asserts the
 * guard its header promises: KILLED vs SURVIVED is told apart, the mutated
 * file comes back byte-identical INCLUDING uncommitted edits (the #831 wipe),
 * a relative path from a subdirectory still targets the right file, and a
 * `--literal` that does not match exactly once aborts instead of reporting.
 *
 * The fixture lives in a fresh non-dot directory under `scripts/` because the
 * nested vitest only runs a path its `include` glob matches, and that glob
 * skips dot directories. It is created after collection, so the outer run
 * never picks it up, and it is gitignored in case a crash leaves it behind.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/mutate.sh");
const DIR = join(ROOT, `scripts/mutate-tmp-${process.pid}-${Date.now()}`);
const TARGET = join(DIR, "target.ts");
const TEST = join(DIR, "target.test.ts");

const TARGET_SRC = `export const add = (a: number, b: number) => a + b;
export const uncovered = (a: number) => a * 2;
export const twice = "x"; export const again = "x";
`;

function mutate(args: string[], cwd = ROOT) {
	// The nested vitest must not believe it is a worker of this one.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")),
	);
	const r = spawnSync("bash", [SCRIPT, ...args], {
		cwd,
		env,
		encoding: "utf8",
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
	mkdirSync(DIR, { recursive: true });
	writeFileSync(TARGET, TARGET_SRC);
	writeFileSync(
		TEST,
		`import { expect, it } from "vitest";
import { add } from "./target";
it("adds", () => expect(add(2, 3)).toBe(5));
`,
	);
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("scripts/mutate.sh", () => {
	it("reports KILLED and restores a file carrying unsaved edits byte-for-byte", () => {
		const dirty = `${TARGET_SRC}// an edit nobody has committed\n`;
		writeFileSync(TARGET, dirty);
		const r = mutate([TARGET, "--literal", "a + b", "a - b", "flip add", TEST]);
		expect(r.out).toContain("KILLED");
		expect(r.code).toBe(0);
		expect(readFileSync(TARGET, "utf8")).toBe(dirty);
		writeFileSync(TARGET, TARGET_SRC);
	}, 120_000);

	it("reports SURVIVED for an uncovered mutation, with paths relative to a subdirectory", () => {
		const rel = (p: string) => p.slice(DIR.length + 1);
		const r = mutate(
			[rel(TARGET), "--literal", "a * 2", "a * 3", "uncovered", rel(TEST)],
			DIR,
		);
		expect(r.out).toContain("SURVIVED");
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	}, 120_000);

	it("aborts, rather than reporting, when --literal does not match exactly once", () => {
		const r = mutate([TARGET, "--literal", '"x"', '"y"', "ambiguous", TEST]);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("occurs 2 times");
		expect(r.out).not.toMatch(/KILLED|SURVIVED/);
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	}, 120_000);
});

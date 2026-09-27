/**
 * #976: `bun run` drops an empty-string argument, so a deletion mutation
 * (`--literal '<old>' '' '<label>' <test>`) reached `scripts/mutate.sh` shifted
 * by one: the label was spliced into the source, the test path became the
 * label, and with no paths left the harness ran the WHOLE suite against the
 * mutated file. Guard 6 refuses that shape before touching the file. Each case
 * asserts the file comes back byte-identical, since a refusal that had already
 * mutated would be the bug in a quieter form.
 *
 * The fixture sits under `scripts/mutate-tmp-*`, the prefix `.gitignore`
 * already covers for `mutate.test.ts`, with its own pid/time suffix so the two
 * files never share a directory when vitest runs them in parallel.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/mutate.sh");
const DIR = join(ROOT, `scripts/mutate-tmp-args-${process.pid}-${Date.now()}`);
const TARGET = join(DIR, "target.ts");
const TEST = join(DIR, "target.test.ts");
const TEST_2 = join(DIR, "target2.test.ts");

const TARGET_SRC = `export const add = (a: number, b: number) => a + b;\n`;

// The nested vitest must not believe it is a worker of this one.
const env = () =>
	Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")),
	);

function direct(args: string[]) {
	const r = spawnSync("bash", [SCRIPT, ...args], {
		cwd: ROOT,
		env: env(),
		encoding: "utf8",
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function viaBun(args: string[]) {
	const r = spawnSync("bun", ["run", "mutate", ...args], {
		cwd: ROOT,
		env: env(),
		encoding: "utf8",
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const rel = (p: string) => relative(ROOT, p);

beforeAll(() => {
	mkdirSync(DIR, { recursive: true });
	writeFileSync(TARGET, TARGET_SRC);
	const body = `import { expect, it } from "vitest";
import { add } from "./target";
it("adds", () => expect(add(2, 3)).toBe(5));
`;
	writeFileSync(TEST, body);
	writeFileSync(TEST_2, body);
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("scripts/mutate.sh argument shape (#976)", () => {
	it("refuses --literal with no vitest path, leaving the file untouched", () => {
		const r = direct([TARGET, "--literal", "a + b", "a - b", "flip add"]);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("no vitest path given");
		expect(r.out).not.toMatch(/baseline|KILLED|SURVIVED/);
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	});

	it("refuses the perl form with no vitest path, leaving the file untouched", () => {
		const r = direct([TARGET, "s/a \\+ b/a - b/", "flip add"]);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("no vitest path given");
		expect(r.out).not.toMatch(/baseline|KILLED|SURVIVED/);
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	});

	it("under `bun run`, refuses an empty <new> and names the direct bash call", () => {
		const r = viaBun([
			rel(TARGET),
			"--literal",
			" + b",
			"",
			"drop b",
			rel(TEST),
		]);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("dropped the ''");
		expect(r.out).toContain("bash scripts/mutate.sh");
		expect(r.out).not.toMatch(/baseline|KILLED|SURVIVED/);
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	}, 60_000);

	it("under `bun run`, refuses the same shift when two test paths leave one behind", () => {
		const r = viaBun([
			rel(TARGET),
			"--literal",
			" + b",
			"",
			"drop b",
			rel(TEST),
			rel(TEST_2),
		]);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("is an existing path");
		expect(r.out).toContain("bash scripts/mutate.sh");
		expect(r.out).not.toMatch(/baseline|KILLED|SURVIVED/);
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	}, 60_000);

	it("called directly, an empty <new> deletes <old> and reports KILLED", () => {
		const r = direct([TARGET, "--literal", " + b", "", "drop b", TEST]);
		expect(r.out).toContain("KILLED");
		expect(r.code).toBe(0);
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	}, 120_000);
});

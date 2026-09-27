/**
 * #976: `bun run` on Bun 1.3.x drops an empty-string argument (1.4.2 keeps
 * it, which is what CI installs), so a deletion mutation
 * (`--literal '<old>' '' '<label>' <test>`) reached `scripts/mutate.sh` shifted
 * by one: the label was spliced into the source, the test path became the
 * label, and with no paths left the harness ran the WHOLE suite against the
 * mutated file. Guard 6 refuses that shape before touching the file. The
 * guard is driven with the ALREADY-shifted argv, which is what it sees on any
 * Bun; the one real `bun run` round trip branches on a probe of whether this
 * Bun drops ''. Every spawn has a timeout, so a regression of the no-path
 * guard (a recursive whole-suite run) fails instead of hanging. Each case
 * asserts the file comes back byte-identical, since a refusal that had already
 * mutated would be the bug in a quieter form.
 *
 * The fixture sits under `scripts/mutate-tmp-*`, the prefix `.gitignore`
 * already covers for `mutate.test.ts`, with its own pid/time suffix so the two
 * files never share a directory when vitest runs them in parallel.
 */
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/mutate.sh");
const DIR = join(ROOT, `scripts/mutate-tmp-args-${process.pid}-${Date.now()}`);
const TARGET = join(DIR, "target.ts");
const TEST = join(DIR, "target.test.ts");
const TEST_2 = join(DIR, "target2.test.ts");

const TARGET_SRC = `export const add = (a: number, b: number) => a + b;\n`;

// A refusal returns in well under a second; a real run is two small vitest
// runs. Anything past this is the whole-suite fallback, which must fail.
const SPAWN_TIMEOUT_MS = 90_000;

// The nested vitest must not believe it is a worker of this one, and a direct
// call must not inherit the `npm_lifecycle_event` that `bun run test` (or
// `bunx`) set on THIS process, or mutate.sh would think it runs under Bun.
const env = () =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([k]) => !k.startsWith("VITEST") && !k.startsWith("npm_lifecycle_"),
		),
	);

function run(cmd: string, args: string[]) {
	const r = spawnSync(cmd, args, {
		cwd: ROOT,
		env: env(),
		encoding: "utf8",
		timeout: SPAWN_TIMEOUT_MS,
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const direct = (args: string[]) => run("bash", [SCRIPT, ...args]);
const viaBun = (args: string[]) => run("bun", ["run", "mutate", ...args]);

/** Does this Bun drop an empty-string argument under `bun run`? */
function bunDropsEmptyArg(): boolean {
	const dir = mkdtempSync(join(tmpdir(), "bun-argv-probe-"));
	try {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { probe: "bash -c 'echo $#' --" } }),
		);
		const r = spawnSync("bun", ["run", "probe", "x", "", "y"], {
			cwd: dir,
			env: env(),
			encoding: "utf8",
			timeout: 30_000,
		});
		const n = Number.parseInt(r.stdout.trim().split("\n").pop() ?? "", 10);
		if (n !== 2 && n !== 3) throw new Error(`argv probe read ${r.stdout}`);
		return n === 2;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const DROPS_EMPTY = bunDropsEmptyArg();

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
	it("refuses --literal with no vitest path, without blaming Bun on a direct call", () => {
		const r = direct([TARGET, "--literal", "a + b", "a - b", "flip add"]);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("no vitest path given");
		expect(r.out).not.toContain("Bun");
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

	it("refuses the argv a dropped '' leaves with one test path (none remain)", () => {
		const r = direct([TARGET, "--literal", " + b", "drop b", TEST]);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("no vitest path given");
		expect(r.out).not.toMatch(/baseline|KILLED|SURVIVED/);
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	});

	it("refuses the argv a dropped '' leaves with two test paths (label is a test file)", () => {
		const r = direct([TARGET, "--literal", " + b", "drop b", TEST, TEST_2]);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("look shifted");
		expect(r.out).not.toMatch(/baseline|KILLED|SURVIVED/);
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	});

	it("under `bun run`, the no-path refusal names the direct bash call", () => {
		const r = viaBun([rel(TARGET), "--literal", "a + b", "a - b", "flip add"]);
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("no vitest path given");
		expect(r.out).toContain("bash scripts/mutate.sh");
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	}, 60_000);

	it("called directly, an empty <new> deletes <old>, and a label that is a real directory is fine", () => {
		const r = direct([TARGET, "--literal", " + b", "", "scripts", TEST]);
		expect(r.out).toContain("KILLED");
		expect(r.code).toBe(0);
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	}, 120_000);

	it(`under \`bun run\`, an empty <new> is ${DROPS_EMPTY ? "refused (this Bun drops '')" : "a normal deletion (this Bun keeps '')"}`, () => {
		const r = viaBun([
			rel(TARGET),
			"--literal",
			" + b",
			"",
			"drop b",
			rel(TEST),
		]);
		if (DROPS_EMPTY) {
			expect(r.code).not.toBe(0);
			expect(r.out).toContain("bash scripts/mutate.sh");
			expect(r.out).not.toMatch(/baseline|KILLED|SURVIVED/);
		} else {
			expect(r.out).toContain("KILLED");
			expect(r.code).toBe(0);
		}
		expect(readFileSync(TARGET, "utf8")).toBe(TARGET_SRC);
	}, 120_000);
});

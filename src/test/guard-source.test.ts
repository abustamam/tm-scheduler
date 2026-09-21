/**
 * The declaration slicer's own self-test (#565, moved here by #761).
 *
 * It lived inside `public-readers-archive-gate.guard.test.ts` while that guard
 * owned `serverFnBody`. `write-proof.guard.test.ts` now classifies the same
 * slices, so a slicing regression would hit two guards and the check belongs
 * beside the slicer rather than inside one of its consumers.
 *
 * What it protects: every classification either guard makes is only as good as
 * the slice it reads, and an over-capturing slice fails SILENTLY and in the
 * dangerous direction — it lends a neighbour's `require*` call to the fn being
 * classified, so the fn drops out of the sweep entirely. That is #565, and it
 * is how #560's minutes leak survived the archive guard behind 54/54 green.
 * Assert the SHAPE of the slices, not just the verdicts.
 *
 * Reads RAW (`readFileSync`, not `readSource`): this is an offender sweep, and
 * blanking comments could only hide a real declaration from it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	serverFnBody,
	serverFnDeclarations,
	stripComments,
	TOP_LEVEL_BOUNDARY,
} from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");
const SERVER = resolve(ROOT, "src/server");

const files = readdirSync(SERVER).filter(
	(f) => f.endsWith(".ts") && !f.includes(".test."),
);

describe("serverFnDeclarations slices a declaration at its own end (#565)", () => {
	// Vacuity check: a walk that finds nothing passes every assertion below.
	it("finds the server-fn modules at all", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	it("finds server fns to slice at all", () => {
		const total = files.reduce(
			(n, f) =>
				n +
				serverFnDeclarations(readFileSync(resolve(SERVER, f), "utf8")).length,
			0,
		);
		expect(total).toBeGreaterThan(100);
	});

	it("slices a server fn's body without running past its own declaration", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const src = readFileSync(resolve(SERVER, file), "utf8");
			for (const decl of serverFnDeclarations(src)) {
				// A column-0 declaration inside the slice means it swallowed a sibling.
				// Skipping the first line, which is the declaration's own.
				const rest = decl.body.slice(decl.body.indexOf("\n") + 1);
				const bled = rest
					.split("\n")
					.find((line) => TOP_LEVEL_BOUNDARY.test(line));
				if (bled !== undefined) {
					offenders.push(
						`${file}:${decl.name} → swallowed "${bled.slice(0, 60)}"`,
					);
				}
			}
		}
		expect(
			offenders,
			`A slice ran past a declaration's own end. Whatever it swallowed is now read as part of that fn, so a neighbour's require* call can classify it as session-guarded and drop it from the sweeps in public-readers-archive-gate.guard.test.ts and write-proof.guard.test.ts — that is #565, and it is how #560's minutes leak survived those guards.\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("reads the method off each declaration", () => {
		// Nothing downstream can classify a POST fn if the method never parses, and
		// an unparsed one drops out of `serverFnDeclarations` SILENTLY — the same
		// failure shape as the over-capture above. So sweep for the inverse: every
		// `createServerFn` export in the tree must have been picked up with a
		// method, and the method must be one of the two the repo uses.
		const missed: string[] = [];
		for (const file of files) {
			const src = readFileSync(resolve(SERVER, file), "utf8");
			const found = new Set(serverFnDeclarations(src).map((d) => d.name));
			for (const m of src.matchAll(/^export const (\w+) = createServerFn/gm)) {
				if (!found.has(m[1] as string)) missed.push(`${file}:${m[1]}`);
			}
			for (const decl of serverFnDeclarations(src)) {
				expect(["GET", "POST"]).toContain(decl.method);
			}
		}
		expect(
			missed,
			`These createServerFn exports were not picked up — their \`method:\` is written in a shape serverFnDeclarations does not match, so every guard that classifies POST fns silently skips them.\n${missed.join("\n")}`,
		).toEqual([]);
	});

	it("throws on a name that is not there rather than returning an empty slice", () => {
		expect(() =>
			serverFnBody("export const other = createServerFn({});", "missing"),
		).toThrow(/missing not found/);
	});

	it("slices comment-blind source too, so a positive assertion can read stripped", () => {
		const src = stripComments(
			readFileSync(resolve(SERVER, "minutes.ts"), "utf8"),
		);
		expect(serverFnBody(src, "setAttendance")).toContain("gateAdmin(");
	});
});

/**
 * Every route that builds a templated deck must hand the builder the ballot URL
 * and the slots (#1635); both are optional on the builder, so a route that drops
 * one typechecks and quietly loses the vote slides' QR or nominees.
 *
 * The routes are FOUND, not listed: any file under `src/routes/` that calls
 * `buildTemplateSlideDeck(` is held to this, so a third route is enrolled the
 * day it is written. The call is sliced by matching its braces, not by
 * indentation, so a reformat cannot empty the slice.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES_DIR = "src/routes";

function routeFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return routeFiles(path);
		return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
			? [path]
			: [];
	});
}

/** The `buildTemplateSlideDeck({ … })` call's argument text, by brace match. */
function callArgument(source: string): string {
	const start = source.search(/buildTemplateSlideDeck\(\s*\{/);
	if (start < 0) return "";
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0)
			return source.slice(open, i + 1);
	}
	return "";
}

const callers = routeFiles(ROUTES_DIR).filter((f) =>
	/buildTemplateSlideDeck\(/.test(readSource(f)),
);

describe("templated deck gets the ballot URL and slots", () => {
	it("finds the routes that build one", () => {
		expect(callers.length).toBeGreaterThanOrEqual(2);
	});

	for (const file of callers) {
		it(file, () => {
			const call = callArgument(readSource(file));
			expect(call.length).toBeGreaterThan(0);
			expect(call).toMatch(/\bballotUrl\b/);
			expect(call).toMatch(/\bslots\b/);
		});
	}
});

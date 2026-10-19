/**
 * Source scan (#1239): a status test must name `active`, never "not inactive".
 *
 * `former` joined `active | inactive`. A check written as "not inactive" treats a
 * former member as active, which is how a former member would be assigned roles,
 * invited, or counted. `=== "inactive"` stays allowed: display and transition
 * code needs it. Pure: no database.
 *
 * protects=no non-test file under src/ tests a membership status as "not inactive";
 * fails_when=`ne(members.status, "inactive")` or `status !== "inactive"` is (re)introduced,
 *   including a call split across lines (the regexes span newlines) and read comment-blind;
 * no_claim=other shapes of the same mistake (a negated helper, `!(s === "inactive")`, a
 *   status held in a variable named something else, `ne(` on an aliased table). Comments are
 *   blanked (`#/test/guard-source`), so a comment quoting the pattern neither fails nor hides it.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// `\s` spans newlines, so `ne(\n\tmembers.status,\n\t"inactive",\n)` is caught.
const FORBIDDEN = [
	/ne\(\s*members\.status\s*,\s*"inactive"\s*,?\s*\)/g,
	/status\s*!==\s*"inactive"/g,
];

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		if (!/\.(ts|tsx)$/.test(name)) return [];
		if (/\.test\.(ts|tsx)$/.test(name)) return [];
		return [path];
	});
}

/** `file:line: text` for every forbidden match in `text`, wherever it wraps. */
function offenders(file: string, text: string): string[] {
	const hits: string[] = [];
	for (const re of FORBIDDEN) {
		for (const m of text.matchAll(re)) {
			const line = text.slice(0, m.index).split("\n").length;
			hits.push(`${file}:${line}: ${m[0].replace(/\s+/g, " ")}`);
		}
	}
	return hits;
}

describe("membership status is tested for active, not for 'not inactive' (#1239)", () => {
	it("no source file uses the two forbidden patterns", () => {
		const files = sourceFiles("src");
		// Vacuity floor: a wrong cwd or a moved tree would scan nothing and pass.
		expect(files.length).toBeGreaterThan(100);
		expect(files).toContain(join("src", "server", "account-invite.ts"));
		expect(files).toContain(join("src", "server", "members-logic.ts"));
		const hits = files.flatMap((f) => offenders(f, readSource(f)));
		expect(hits).toEqual([]);
	});

	it("the patterns match the shapes they claim, including a split call", () => {
		expect(offenders("x.ts", 'ne(members.status, "inactive")')).toHaveLength(1);
		expect(
			offenders("x.ts", 'ne(\n\tmembers.status,\n\t"inactive",\n)'),
		).toHaveLength(1);
		expect(offenders("x.ts", 'r.status !== "inactive"')).toHaveLength(1);
		expect(offenders("x.ts", 'r.status === "inactive"')).toHaveLength(0);
	});
});

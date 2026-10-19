/**
 * Source scan (#1239): a status test must name `active`, never "not inactive".
 *
 * `former` joined `active | inactive`. A check written as "not inactive" treats a
 * former member as active, which is how a former member would be assigned roles,
 * invited, or counted. `=== "inactive"` stays allowed: display and transition
 * code needs it. Pure: no database.
 *
 * protects=no non-test file under src/ tests a membership status as "not inactive";
 * fails_when=`ne(members.status, "inactive")` or `status !== "inactive"` is (re)introduced;
 * no_claim=other shapes of the same mistake (a negated helper, `!(s === "inactive")`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = [
	/ne\(\s*members\.status\s*,\s*"inactive"\s*\)/,
	/status\s*!==\s*"inactive"/,
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

describe("membership status is tested for active, not for 'not inactive' (#1239)", () => {
	it("no source file uses the two forbidden patterns", () => {
		const hits: string[] = [];
		for (const file of sourceFiles("src")) {
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (FORBIDDEN.some((re) => re.test(line))) {
						hits.push(`${file}:${i + 1}: ${line.trim()}`);
					}
				});
		}
		expect(hits).toEqual([]);
	});
});

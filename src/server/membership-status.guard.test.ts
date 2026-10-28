/**
 * Source scan (#1239, #1326): a status test must name the statuses it wants,
 * never "not inactive" or "not former".
 *
 * `former` joined `active | inactive`. A check written as "not inactive" treats a
 * former member as active, which is how a former member would be assigned roles,
 * invited, or counted. The same shape against the NEXT status added would leak it
 * through every such filter, so the statuses come from the schema's enum.
 * `=== "inactive"` stays allowed: display and transition code needs it, and so does
 * `!== "active"` (an allow-list: every other status, present or future, is refused).
 * Pure: no database.
 *
 * protects=no non-test file under src/ tests a membership status negatively against
 *   any status literal other than "active" (the literals are read from
 *   `membershipStatusEnum`);
 * fails_when=`ne(<any alias>.status, "inactive")`, `x.status !== "former"` / `!=`
 *   (either operand order), `notInArray(<any>.status, …)` or raw SQL `status <> '…'` /
 *   `!= '…'` / `NOT IN (…)` is (re)introduced, including a call split across lines
 *   (the regexes span newlines) and read comment-blind;
 * no_claim=a negated helper, `!(s === "inactive")`, a status held in a variable named
 *   something else, a column not spelled `.status`/`status`. Comments are blanked
 *   (`#/test/guard-source`), so a comment quoting the pattern neither fails nor hides it.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { membershipStatusEnum } from "#/db/schema";
import { readSource } from "#/test/guard-source";

/** Every status but "active": a negative test against "active" is an allow-list. */
const GUARDED_STATUSES = membershipStatusEnum.enumValues.filter(
	(v) => v !== "active",
);
const LIT = String.raw`(?:${GUARDED_STATUSES.join("|")})`;
// JS code is double-quoted (Biome); a raw SQL literal is single-quoted.
const DQ = String.raw`"${LIT}"`;
const SQ = String.raw`'${LIT}'`;
// `\s` spans newlines, so `ne(\n\tmembers.status,\n\t"inactive",\n)` is caught.
const FORBIDDEN = [
	// ne(members.status, "x"), ne(m.status, 'x'), ne(alias.status, "x")
	new RegExp(String.raw`\bne\(\s*[\w$.]+\.status\s*,\s*${DQ}\s*,?\s*\)`, "g"),
	// x.status !== "x", x?.status != "x", and the literal on the left
	new RegExp(String.raw`\bstatus\s*!==?\s*${DQ}`, "g"),
	new RegExp(String.raw`${DQ}\s*!==?\s*[\w$.?]*\bstatus\b`, "g"),
	// notInArray(members.status, [...])
	/\bnotInArray\(\s*[\w$.]+\.status\b/g,
	// raw SQL: status <> 'x', m.status != 'x', status NOT IN ('x', ...)
	new RegExp(String.raw`\bstatus\s*(?:<>|!=)\s*${SQ}`, "gi"),
	/\bstatus\s+not\s+in\s*\(/gi,
];

/**
 * Sites the scan cannot make fail yet, because their files are outside #1326's
 * change set: each is a pre-existing negative filter that a fourth status would
 * leak through. A site is listed by file, with the number of matches it holds; a
 * new match in a listed file, or a listed file that holds fewer, fails the test.
 * The scan's pattern grew in #1326 (any alias, `!=`, `notInArray`, raw SQL): the
 * one site it added is `ne(vouching.status, "former")` in account-link-logic.ts
 * (an aliased table); the list shrinks as the files are fixed.
 */
const KNOWN_UNFIXED: Record<string, number> = {
	"src/routes/_authed/roster.tsx": 1,
	"src/server/account-link-logic.ts": 2,
	"src/server/club-export-logic.ts": 2,
	"src/server/guest-pipeline-logic.ts": 1,
	"src/server/membership-collapse-logic.ts": 1,
};

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		if (!/\.(ts|tsx)$/.test(name)) return [];
		if (/\.test\.(ts|tsx)$/.test(name)) return [];
		return [path];
	});
}

/** A Windows path as the `/`-separated key `KNOWN_UNFIXED` uses. */
function toPosix(path: string): string {
	return path.split("\\").join("/");
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

/**
 * The hits that are not allowed: every hit of a file holding MORE than its listed
 * count (an unlisted file is listed at 0). A listed file holding fewer is the
 * caller's second check.
 */
function unexpectedHits(
	byFile: Map<string, string[]>,
	known: Record<string, number>,
): string[] {
	return [...byFile].flatMap(([f, hits]) => {
		const allowed = known[f] ?? 0;
		return hits.length > allowed ? hits : [];
	});
}

describe("membership status is never tested negatively (#1239, #1326)", () => {
	it("no source file uses a negative filter against a non-active status, beyond the known list", () => {
		const files = sourceFiles("src");
		// Vacuity floor: a wrong cwd or a moved tree would scan nothing and pass.
		expect(files.length).toBeGreaterThan(100);
		expect(files).toContain(join("src", "server", "account-invite.ts"));
		expect(files).toContain(join("src", "server", "members-logic.ts"));
		const byFile = new Map<string, string[]>();
		for (const f of files) {
			const hits = offenders(f, readSource(f));
			if (hits.length) byFile.set(toPosix(f), hits);
		}
		expect(unexpectedHits(byFile, KNOWN_UNFIXED)).toEqual([]);
		for (const [f, n] of Object.entries(KNOWN_UNFIXED)) {
			expect({ file: f, count: byFile.get(f)?.length ?? 0 }).toEqual({
				file: f,
				count: n,
			});
		}
	});

	it("a Windows path becomes the key the known list uses", () => {
		expect(toPosix("src\\server\\a.ts")).toBe("src/server/a.ts");
		expect(toPosix("src/server/a.ts")).toBe("src/server/a.ts");
	});

	it("the literals are the schema's statuses but active", () => {
		expect(GUARDED_STATUSES).toEqual(["inactive", "former"]);
	});

	it("the patterns match the shapes they claim, including a split call", () => {
		const hit = (t: string) => offenders("x.ts", t).length;
		for (const lit of GUARDED_STATUSES) {
			expect(hit(`ne(members.status, "${lit}")`)).toBe(1);
			expect(hit(`ne(m.status, "${lit}")`)).toBe(1);
			expect(hit(`ne(\n\tmembers.status,\n\t"${lit}",\n)`)).toBe(1);
			expect(hit(`r.status !== "${lit}"`)).toBe(1);
			expect(hit(`r?.status != "${lit}"`)).toBe(1);
			expect(hit(`"${lit}" !== r.status`)).toBe(1);
			expect(hit(`status !== "${lit}"`)).toBe(1);
			expect(hit(`"${lit}" !== status`)).toBe(1);
			expect(hit(`status != "${lit}"`)).toBe(1);
			expect(hit(`sql\`status <> '${lit}'\``)).toBe(1);
			expect(hit(`sql\`m.status != '${lit}'\``)).toBe(1);
			expect(hit(`r.status === "${lit}"`)).toBe(0);
		}
		expect(hit("notInArray(members.status, bad)")).toBe(1);
		expect(hit("notInArray(\n\tm.status,\n\tbad,\n)")).toBe(1);
		expect(hit("sql`status NOT IN ('inactive', 'former')`")).toBe(1);
		// Allowed: the positive form, and an allow-list on "active".
		expect(hit('inArray(members.status, ["active", "inactive"])')).toBe(0);
		expect(hit("inArray(members.status, [...ROSTER_STATUSES])")).toBe(0);
		expect(hit('m.status !== "active"')).toBe(0);
		expect(hit('ne(members.status, "active")')).toBe(0);
	});

	it("an unlisted file with a hit, or a listed file with an extra one, is unexpected", () => {
		const one = ["a.ts:1: x"];
		const two = ["b.ts:1: x", "b.ts:2: y"];
		expect(unexpectedHits(new Map([["a.ts", one]]), {})).toEqual(one);
		expect(unexpectedHits(new Map([["b.ts", two]]), { "b.ts": 1 })).toEqual(
			two,
		);
		expect(unexpectedHits(new Map([["b.ts", two]]), { "b.ts": 2 })).toEqual([]);
	});
});

/**
 * `getMembership` is gone (#1343): the one membership lookup is
 * `getActiveMembership` (`guards.ts`), which filters `status = 'active'` in its
 * query, so no caller can forget the status test. This replaces a ~240-line
 * source scan that checked each caller tested the status itself.
 *
 * protects=no non-test source file under src/ uses the identifier `getMembership`
 *   as code, and `guards.ts` exports `getActiveMembership`;
 * fails_when=`getMembership` is (re)introduced anywhere as an import, a call, a
 *   definition or an alias (comments are blanked, so one may still be named in prose);
 * no_claim=that `getActiveMembership`'s query keeps its `active` filter: the
 *   integration suites beside each reader (`membership-resolution`,
 *   `meeting-authz-membership-pick`, `pathways-membership-pick`) assert a
 *   non-active row resolves to null.
 */
describe("nothing uses the any-status membership lookup (#1343)", () => {
	it("no source file mentions getMembership as code", () => {
		const files = sourceFiles("src");
		// Vacuity floor: a wrong cwd or a moved tree would scan nothing and pass.
		expect(files.length).toBeGreaterThan(100);
		expect(files).toContain(join("src", "server", "guards.ts"));
		const offenders = files.filter((f) =>
			/(?<![\w$])getMembership(?![\w$])/.test(readSource(f)),
		);
		expect(offenders).toEqual([]);
	});

	it("guards.ts exports getActiveMembership and filters on active in the query", () => {
		const src = readSource("src/server/guards.ts");
		expect(src).toMatch(/export async function getActiveMembership\(/);
		expect(src).toMatch(/eq\(members\.status,\s*"active"\)/);
	});
});

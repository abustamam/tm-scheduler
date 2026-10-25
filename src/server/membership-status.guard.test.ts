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
import { readSource, stripComments } from "#/test/guard-source";

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

/**
 * Source scan: every caller of `getMembership(` is classified.
 *
 * `getMembership` has no status filter, and ending or deactivating a membership
 * leaves `club_role` alone, so its row says "admin" for a member who is no longer
 * one. A caller that reads `clubRole` (or only the row's existence) off it grants
 * a members-only read to a membership that is not active. Guarding the one place
 * that did it (`canManageClub`) leaves the next caller free to do it again, so
 * this guard lists the CALLERS: each non-test call site either tests
 * `status === "active"` on its result, or sits in {@link ATTRIBUTION_ONLY} with
 * the reason it needs none. A new, unclassified caller fails the test.
 *
 * protects=no non-test `getMembership(` call under src/ is left unclassified;
 * fails_when=a caller drops its `status === "active"` test, or a new caller is
 *   added with none, or an allowlisted file gains a second unchecked call;
 * no_claim=that a classified caller USES the status correctly (the check is
 *   looked for on the bound variable within the next 40 lines, or directly on
 *   the call); the integration suites beside each reader assert that. Comments
 *   are blanked, so a comment quoting the call neither counts nor hides one. A
 *   `//` inside a string literal on the same line blanks the rest of it.
 */

/** The text of a call that tests the membership's status as `"active"`. */
const CALL = /(?<!function\s+)\bgetMembership\s*\(/g;
const STATUS_WINDOW_LINES = 40;

/**
 * Files whose `getMembership(` result is read for attribution only, with how many
 * such calls the file holds. A count, not a flag: a second unchecked call in the
 * same file is a new caller and must be classified on its own.
 */
const ATTRIBUTION_ONLY: Record<string, { calls: number; reason: string }> = {
	"src/server/speech-log-edit-logic.ts": {
		calls: 1,
		reason:
			"reads only the actor's member id, for the activity row, after assertStillClubAdmin (active admin or read_write impersonation) has already passed in the same transaction; null when there is no membership",
	},
	"src/server/guest-pipeline-logic.ts": {
		calls: 2,
		reason:
			"reads only the officer's member id, to credit the new record or the activity row, after assertStillAdminOfBothClubs has already passed in the same transaction; null when there is no membership",
	},
};

/** Index of the `)` closing the call whose `(` is at `open`, or -1. */
function closeOf(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return i;
	}
	return -1;
}

/** Does the call at `at` (the `getMembership` token) test its result's status as active? */
function testsActive(text: string, at: number): boolean {
	const open = text.indexOf("(", at);
	const close = closeOf(text, open);
	if (close === -1) return false;
	// `(await getMembership(...))?.status === "active"`, tested right on the call.
	const inline = text.slice(close + 1, close + 60);
	if (/^\s*\)*\s*\??\.status\s*(?:===|!==)\s*"active"/.test(inline))
		return true;
	// `const m = await getMembership(...)` (or `cond ? await getMembership(...) :
	// null`), then `m?.status === "active"` below it.
	const before = text.slice(Math.max(0, at - 120), at);
	const bound = /(?:const|let|var)\s+(\w+)\s*=\s*[^;]*?\bawait\s+$/.exec(
		before,
	);
	if (!bound) return false;
	const window = text
		.slice(close)
		.split("\n")
		.slice(0, STATUS_WINDOW_LINES)
		.join("\n");
	return new RegExp(
		`\\b${bound[1]}\\s*\\??\\.status\\s*(?:===|!==)\\s*"active"`,
	).test(window);
}

/** `file:line` for every unclassified `getMembership(` caller in `files`. */
function unclassifiedCallers(
	files: Record<string, string>,
	allow: Record<string, { calls: number; reason: string }>,
): string[] {
	const hits: string[] = [];
	for (const [file, raw] of Object.entries(files)) {
		const text = stripComments(raw);
		const unchecked: number[] = [];
		for (const m of text.matchAll(CALL)) {
			if (testsActive(text, m.index)) continue;
			unchecked.push(text.slice(0, m.index).split("\n").length);
		}
		const allowed = allow[file]?.calls ?? 0;
		if (unchecked.length === allowed) continue;
		for (const line of unchecked) {
			hits.push(
				`${file}:${line}: getMembership( with no status === "active" test, and ${allowed} allowlisted call(s) in this file`,
			);
		}
		// An allowlist entry that no longer matches anything is stale, not harmless.
		if (unchecked.length === 0) {
			hits.push(`${file}: allowlisted for ${allowed} call(s), found none`);
		}
	}
	return hits;
}

describe("every getMembership( caller tests for an active membership or says why not", () => {
	it("no source file has an unclassified caller", () => {
		const files = sourceFiles("src").map((f) => f.split("\\").join("/"));
		const sources = Object.fromEntries(files.map((f) => [f, readSource(f)]));
		// Vacuity floor: a wrong cwd, a moved tree or a changed pattern would find
		// no callers and pass. Each of these is a reader that must be seen.
		const called = Object.entries(sources).filter(([, text]) =>
			new RegExp(CALL.source).test(text),
		);
		expect(called.length).toBeGreaterThanOrEqual(10);
		const calls = called.reduce(
			(n, [, text]) => n + [...stripComments(text).matchAll(CALL)].length,
			0,
		);
		expect(calls).toBeGreaterThanOrEqual(15);
		const names = called.map(([f]) => f);
		for (const f of [
			"src/server/guards.ts",
			"src/server/meetings.ts",
			"src/server/minutes.ts",
			"src/server/guest-pipeline-logic.ts",
		]) {
			expect(names).toContain(f);
		}
		expect(unclassifiedCallers(sources, ATTRIBUTION_ONLY)).toEqual([]);
	});

	it("every allowlisted file exists and states a reason", () => {
		for (const [file, entry] of Object.entries(ATTRIBUTION_ONLY)) {
			expect(readSource(file).length).toBeGreaterThan(0);
			expect(entry.reason.length).toBeGreaterThan(40);
		}
	});

	it("accepts the shapes that test status, however the result is bound", () => {
		const ok = (text: string) => unclassifiedCallers({ "x.ts": text }, {});
		expect(
			ok(
				'const m = await getMembership(u, c);\nif (!m || m.status !== "active") throw new Error("no");',
			),
		).toEqual([]);
		expect(
			ok(
				'const m = await getMembership(u, c, tx);\nif (m && m.status === "active") return m;',
			),
		).toEqual([]);
		expect(
			ok(
				'const found = await getMembership(u, c);\nconst m = found?.status === "active" ? found : null;',
			),
		).toEqual([]);
		expect(ok('v = (await getMembership(u, c))?.status === "active";')).toEqual(
			[],
		);
	});

	it("flags a caller that does not test for active", () => {
		const bad = (text: string) =>
			unclassifiedCallers({ "x.ts": text }, {}).length;
		// No test at all: the row's existence, or its stored role, is the grant.
		expect(bad("v = !!(await getMembership(u, c));")).toBe(1);
		expect(
			bad(
				'const m = await getMembership(u, c);\nreturn m.clubRole === "admin";',
			),
		).toBe(1);
		// A status test that is not the active one.
		expect(
			bad(
				'const m = await getMembership(u, c);\nif (m.status === "former") return false;',
			),
		).toBe(1);
		// A test of ANOTHER variable's status does not classify this call.
		expect(
			bad(
				'const m = await getMembership(u, c);\nconst other = row;\nreturn other.status === "active";',
			),
		).toBe(1);
		// Two callers, one tested: the untested one is reported on its own line.
		const two = unclassifiedCallers(
			{
				"x.ts":
					'const a = await getMembership(u, c);\nif (a.status === "active") {}\nconst b = await getMembership(u, d);\nreturn b.id;',
			},
			{},
		);
		expect(two).toHaveLength(1);
		expect(two[0]).toContain("x.ts:3:");
	});

	it("an allowlisted file holds exactly its listed number of unchecked callers", () => {
		const allow = {
			"x.ts": { calls: 1, reason: "attribution only, for test" },
		};
		const one = "const a = await getMembership(u, c);\nreturn a?.id ?? null;";
		expect(unclassifiedCallers({ "x.ts": one }, allow)).toEqual([]);
		// A second unchecked caller is a new caller: both lines are reported.
		expect(
			unclassifiedCallers({ "x.ts": `${one}\n${one}` }, allow),
		).toHaveLength(2);
		// The same shape in a file that is not allowlisted is unclassified.
		expect(unclassifiedCallers({ "y.ts": one }, allow)).toHaveLength(1);
		// An entry whose file no longer has the call is stale.
		expect(unclassifiedCallers({ "x.ts": "const a = 1;" }, allow)).toHaveLength(
			1,
		);
	});

	it("neither the definition nor a comment is a caller", () => {
		const none = (text: string) => unclassifiedCallers({ "x.ts": text }, {});
		expect(
			none("export async function getMembership(userId: string) {}"),
		).toEqual([]);
		expect(none("type T = Awaited<ReturnType<typeof getMembership>>;")).toEqual(
			[],
		);
		// A comment quoting a call is not one, and does not hide a real one.
		expect(none("// getMembership(u, c) is the old way\nconst x = 1;")).toEqual(
			[],
		);
		expect(
			none("/* getMembership(u, c) */ v = !!(await getMembership(u, c));"),
		).toHaveLength(1);
	});
});

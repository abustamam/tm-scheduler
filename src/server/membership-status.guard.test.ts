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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { membershipStatusEnum } from "#/db/schema";
import { readSource, TOP_LEVEL_BOUNDARY } from "#/test/guard-source";

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
 * Source scan: every use of `getMembership` is a call that tests its own result.
 *
 * `getMembership` returns the user's row for a club whatever its status, and a row
 * keeps its stored `club_role` after the membership ends. A members-only read
 * therefore takes the one row and requires it to be active. Guarding one reader
 * leaves the next free to skip the test, so this guard lists the CALLERS: each
 * non-test `getMembership(...)` call under src/ tests `status === "active"` on
 * its OWN result, and the name is used in no other shape.
 *
 * What counts as a test of the call's own result:
 *   - inline: `(await getMembership(...))?.status === "active"` (or `!==`);
 *   - or the call is bound, `const|let|var X = ...getMembership(...)`, and `X`
 *     (not `row.X`) is compared to `"active"` inside the call's window. The window
 *     ends at the first of: the next `getMembership` token, the `}` that closes
 *     the block the call sits in, or a column-0 line that starts a top-level
 *     declaration. A window that redeclares `X` does not count.
 *
 * What counts as a use of the name: a direct call, a plain named import
 * specifier (no `as`), `typeof getMembership`, and the definition in
 * `src/server/guards.ts`. Anything else (an `as` alias, a re-export, a variable
 * bound to the function, a callback, `getMembership?.(`, `["getMembership"]`)
 * is reported, because a call made through it is no longer read by this scan.
 *
 * There is no allowlist. A call that has a reason to skip the test is an edit to
 * this file, visible in review.
 *
 * protects=every non-test `getMembership(` call under src/ tests the status of its
 *   own result as `"active"`, and the name is used in no shape this scan cannot read;
 * fails_when=a caller drops its `status === "active"` test, or tests another
 *   variable, or tests the right one only past the end of its window; a new caller
 *   is added with none; the name is aliased, re-exported, bound to a variable,
 *   passed as a callback, called as `getMembership?.(`, reached through
 *   `["getMembership"]`, or defined outside `guards.ts`;
 * no_claim=that the status test gates anything: data flow is not tracked, and a
 *   test that is present but gates nothing is not detected (the integration suites
 *   beside each reader assert behaviour). Comments are blanked by a string-aware
 *   pass, so a comment quoting the call neither counts nor hides one; a regex
 *   literal holding a quote or a backtick is not tracked and would skew it, and a
 *   string that quotes the name is read as a use of it.
 */

const NAME = "getMembership";
const DEFINITION_FILE = "src/server/guards.ts";
/** `getMembership` as a complete identifier, wherever it sits (a `.name` access too). */
const TOKEN = /(?<![\w$])getMembership(?![\w$])/g;
/** A comparison of a `.status` to the active status, optionally `?.`. */
const STATUS_ACTIVE = String.raw`\??\.status\s*(?:===|!==)\s*"active"`;

interface Scanned {
	/** The source with every comment blanked; strings are kept. */
	code: string;
	/** `code` with the text of every string and template literal blanked too. */
	skeleton: string;
}

/**
 * Blank comments, string-aware: a `//` or a quote inside a string or a template
 * literal (with `${...}` nested to any depth) is text, not a comment or a string
 * opener. Both outputs keep the input's length and newlines, so offsets and line
 * numbers hold. `stripComments` in `#/test/guard-source` is not used here: it
 * blanks a `//` inside a string, which would blank a call sitting after it.
 */
function scan(src: string): Scanned {
	let code = "";
	let skeleton = "";
	const blankOf = (s: string) => s.replace(/[^\n]/g, " ");
	const asCode = (s: string) => {
		code += s;
		skeleton += s;
	};
	const asText = (s: string) => {
		code += s;
		skeleton += blankOf(s);
	};
	const asComment = (s: string) => {
		code += blankOf(s);
		skeleton += blankOf(s);
	};

	/** A quoted string from its opening quote; returns the index after it. */
	function quoted(from: number, quote: string): number {
		asCode(quote);
		let i = from + 1;
		while (i < src.length && src[i] !== quote && src[i] !== "\n") {
			const step = src[i] === "\\" ? 2 : 1;
			asText(src.slice(i, i + step));
			i += step;
		}
		if (src[i] === quote) {
			asCode(quote);
			i++;
		}
		return i;
	}

	/** A template literal from its backtick; returns the index after it. */
	function template(from: number): number {
		asCode("`");
		let i = from + 1;
		while (i < src.length && src[i] !== "`") {
			if (src[i] === "$" && src[i + 1] === "{") {
				asCode("${");
				i = walk(i + 2, true);
			} else {
				const step = src[i] === "\\" ? 2 : 1;
				asText(src.slice(i, i + step));
				i += step;
			}
		}
		if (src[i] === "`") {
			asCode("`");
			i++;
		}
		return i;
	}

	/** Code from `from`; inside a `${`, stops after the `}` that closes it. */
	function walk(from: number, inExpr: boolean): number {
		let depth = 0;
		let i = from;
		while (i < src.length) {
			const c = src[i] as string;
			const next = src[i + 1];
			if (c === "/" && next === "/") {
				const eol = src.indexOf("\n", i);
				const end = eol === -1 ? src.length : eol;
				asComment(src.slice(i, end));
				i = end;
			} else if (c === "/" && next === "*") {
				const close = src.indexOf("*/", i + 2);
				const end = close === -1 ? src.length : close + 2;
				asComment(src.slice(i, end));
				i = end;
			} else if (c === '"' || c === "'") {
				i = quoted(i, c);
			} else if (c === "`") {
				i = template(i);
			} else if (c === "}" && inExpr && depth === 0) {
				asCode("}");
				return i + 1;
			} else {
				if (c === "{") depth++;
				else if (c === "}") depth--;
				asCode(c);
				i++;
			}
		}
		return i;
	}

	walk(0, false);
	return { code, skeleton };
}

/** Index of the `)` closing the call whose `(` is at `open`, or -1. */
function closeOf(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return i;
	}
	return -1;
}

/** Token offsets of every `getMembership` in `code`. */
function tokenOffsets(code: string): number[] {
	return [...code.matchAll(TOKEN)].map((m) => m.index);
}

const isCallAt = (code: string, at: number) =>
	/^\s*\(/.test(code.slice(at + NAME.length, at + NAME.length + 40));

/** The 80 characters before `at` (fewer at the start of the file). */
const lookBehind = (code: string, at: number) =>
	code.slice(Math.max(0, at - 80), at);

/** Offsets of the direct calls in `code`; the `function getMembership(` definition is not one. */
function callSites(code: string): number[] {
	return tokenOffsets(code).filter(
		(at) => isCallAt(code, at) && !/\bfunction\s+$/.test(lookBehind(code, at)),
	);
}

/** Is the token at `at` a plain `import { getMembership }` specifier, with no `as`? */
function isImportSpecifier(code: string, at: number): boolean {
	const open = code.lastIndexOf("{", at);
	const close = code.indexOf("}", at);
	if (open === -1 || close === -1) return false;
	if (code.slice(open + 1, at).includes("}")) return false;
	if (
		!/\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?$/.test(lookBehind(code, open))
	)
		return false;
	return (
		/(?:^|,)\s*(?:type\s+)?$/.test(code.slice(open + 1, at)) &&
		/^\s*(?:,|$)/.test(code.slice(at + NAME.length, close))
	);
}

/** End of the window a status test may sit in, for a call that closes at `from - 1`. */
function windowEnd(skeleton: string, from: number, nextToken: number): number {
	let depth = 0;
	for (let i = from; i < nextToken; i++) {
		const c = skeleton[i];
		if (c === "{") depth++;
		else if (c === "}") {
			if (depth === 0) return i;
			depth--;
		} else if (
			c === "\n" &&
			TOP_LEVEL_BOUNDARY.test(skeleton.slice(i + 1, i + 20))
		) {
			return i;
		}
	}
	return nextToken;
}

const UNTESTED = `${NAME}( result is not tested with status === "active"`;

/** The reason the call at `at` does not test its own result, or null when it does. */
function callProblem(
	{ code, skeleton }: Scanned,
	at: number,
	nextToken: number,
): string | null {
	const close = closeOf(skeleton, skeleton.indexOf("(", at));
	if (close === -1) return `${NAME}( is never closed`;
	const inline = new RegExp(`^\\s*\\)\\s*${STATUS_ACTIVE}`);
	if (
		/\(\s*await\s+$/.test(lookBehind(code, at)) &&
		inline.test(code.slice(close + 1, close + 80))
	) {
		return null;
	}
	const stmtStart =
		Math.max(
			skeleton.lastIndexOf(";", at),
			skeleton.lastIndexOf("{", at),
			skeleton.lastIndexOf("}", at),
		) + 1;
	const bound = /^\s*(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=/.exec(
		code.slice(stmtStart, at),
	);
	if (!bound) return UNTESTED;
	const name = (bound[1] as string).replace(/\$/g, "\\$");
	const win = code.slice(close + 1, windowEnd(skeleton, close + 1, nextToken));
	if (new RegExp(`\\b(?:const|let|var)\\s+${name}(?![\\w$])`).test(win)) {
		return `${UNTESTED} (the window redeclares ${bound[1]})`;
	}
	const tested = new RegExp(`(?<![\\w$.])${name}\\s*${STATUS_ACTIVE}`);
	return tested.test(win) ? null : UNTESTED;
}

/** `file:line: reason` for every use of `getMembership` in `source` that is not allowed. */
function membershipFindings(file: string, source: string): string[] {
	const scanned = scan(source);
	const { code } = scanned;
	const tokens = tokenOffsets(code);
	const findings: string[] = [];
	tokens.forEach((at, n) => {
		const before = lookBehind(code, at);
		let problem: string | null;
		if (/\bfunction\s+$/.test(before)) {
			problem =
				file === DEFINITION_FILE && isCallAt(code, at)
					? null
					: `${NAME} is defined outside ${DEFINITION_FILE}`;
		} else if (isCallAt(code, at)) {
			problem = callProblem(scanned, at, tokens[n + 1] ?? code.length);
		} else if (/\btypeof\s+$/.test(before) || isImportSpecifier(code, at)) {
			problem = null;
		} else {
			problem = `${NAME} is used other than as a direct call, a plain import or typeof`;
		}
		if (problem) {
			const line = code.slice(0, at).split("\n").length;
			findings.push(`${file}:${line}: ${problem}`);
		}
	});
	return findings;
}

describe("every getMembership( call tests its own result for an active membership", () => {
	it("no source file has an unchecked call or a use the scan cannot read", () => {
		const files = sourceFiles("src").map((f) => f.split("\\").join("/"));
		const sources = Object.fromEntries(
			files.map((f) => [f, readFileSync(f, "utf8")]),
		);
		// Vacuity floor: a wrong cwd, a moved tree or a changed pattern would find
		// no callers and pass. Each of these is a reader that must be seen.
		const called = Object.entries(sources)
			.map(([f, text]) => [f, callSites(scan(text).code).length] as const)
			.filter(([, n]) => n > 0);
		expect(called.length).toBeGreaterThanOrEqual(10);
		expect(called.reduce((n, [, k]) => n + k, 0)).toBeGreaterThanOrEqual(15);
		const names = called.map(([f]) => f);
		for (const f of [
			"src/server/guards.ts",
			"src/server/meetings.ts",
			"src/server/minutes.ts",
			"src/server/guest-pipeline-logic.ts",
		]) {
			expect(names).toContain(f);
		}
		expect(
			Object.entries(sources).flatMap(([f, text]) =>
				membershipFindings(f, text),
			),
		).toEqual([]);
	});

	it("the comment blanker keeps strings and templates as text and offsets true", () => {
		const src =
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source text for the scanner under test.
			'const u = "//"; // note\nconst t = `a ${f(`b ${getMembership(1)}`)} // text`;\ngetMembership(2); /* x */';
		const { code, skeleton } = scan(src);
		expect(code).toHaveLength(src.length);
		expect(skeleton).toHaveLength(src.length);
		expect(code.split("\n")).toHaveLength(src.split("\n").length);
		// Comments are gone; the `//` in a string and in template text stay.
		expect(code).not.toContain("note");
		expect(code).not.toContain("x */");
		expect(code).toContain('"//"');
		expect(code).toContain("// text");
		// The skeleton also drops string and template text, but keeps `${...}` code.
		expect(skeleton).not.toContain("// text");
		expect(skeleton).toContain("getMembership(1)");
		expect(callSites(code)).toHaveLength(2);
		// A quote or an opener inside a string does not start another one.
		const odd = scan("const a = \"'\"; const b = '`'; getMembership(1);");
		expect(callSites(odd.code)).toHaveLength(1);
		expect(odd.skeleton).toContain("getMembership(1)");
	});

	it("accepts a call whose own result is tested for active", () => {
		const ok = (text: string) => membershipFindings("x.ts", text);
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
				'async function f() {\n\tconst found = await getMembership(u, c);\n\tconst m = found?.status === "active" ? found : null;\n}',
			),
		).toEqual([]);
		expect(ok('v = (await getMembership(u, c))?.status === "active";')).toEqual(
			[],
		);
		// Bound through a conditional, the shape the meeting reader uses.
		expect(
			ok(
				'const m = s\n\t? await getMembership(s, c)\n\t: null;\nreturn m?.status === "active";',
			),
		).toEqual([]);
		// The window is not a line count: a long body and a nested block both reach it.
		const filler = "\tuse();\n".repeat(80);
		expect(
			ok(
				`function f() {\n\tconst m = await getMembership(u, c);\n${filler}\tif (x) {\n\t\tif (m.status === "active") {}\n\t}\n}`,
			),
		).toEqual([]);
		// A string holding `//` before the call does not hide the test below it.
		expect(
			ok(
				'const u = "//";\nconst m = await getMembership(u, c);\nreturn m.status === "active";',
			),
		).toEqual([]);
	});

	it("reports a call that does not test its own result", () => {
		const bad = (text: string) => membershipFindings("x.ts", text);
		// No test at all: the row's existence, or its stored role, is the grant.
		expect(bad("v = !!(await getMembership(u, c));")).toHaveLength(1);
		expect(
			bad(
				'const m = await getMembership(u, c);\nreturn m.clubRole === "admin";',
			),
		).toHaveLength(1);
		// A status test that is not the active one.
		expect(
			bad(
				'const m = await getMembership(u, c);\nif (m.status === "former") return false;',
			),
		).toHaveLength(1);
		// A test on ANOTHER variable, or on a property of another object.
		expect(
			bad(
				'const m = await getMembership(u, c);\nconst other = row;\nreturn other.status === "active";',
			),
		).toHaveLength(1);
		expect(
			bad(
				'const m = await getMembership(u, c);\nreturn row.m.status === "active";',
			),
		).toHaveLength(1);
		// Not bound to a name, and not tested inline.
		expect(
			bad('return (await getMembership(u, c)) && row.status === "active";'),
		).toHaveLength(1);
		// A call behind `typeof` still runs.
		expect(bad("const t = typeof getMembership(u, c);")).toHaveLength(1);
		// A call that only a string quoting `//` precedes is still read.
		expect(
			bad(
				'const u = "//";\nconst m = await getMembership(u, c);\nreturn m.clubRole;',
			),
		).toHaveLength(1);
	});

	it("a test outside the call's window does not count", () => {
		const bad = (text: string) => membershipFindings("x.ts", text);
		// Two functions: only the second tests, and it is not the first's block.
		const two = bad(
			'async function a() {\n\tconst m = await getMembership(u, c);\n\treturn m.clubRole;\n}\nfunction b(m) {\n\treturn m.status === "active";\n}',
		);
		expect(two).toHaveLength(1);
		expect(two[0]).toContain("x.ts:2:");
		// Two sequential calls, the first untested: the second's test is not the first's.
		const seq = bad(
			'const a = await getMembership(u, c);\nuse(a);\nconst b = await getMembership(u, d);\nif (a.status === "active" && b.status === "active") {}',
		);
		expect(seq).toHaveLength(1);
		expect(seq[0]).toContain("x.ts:1:");
		// A top-level call stops at the next top-level declaration.
		expect(
			bad(
				'const m = await getMembership(u, c);\nconst k = 1;\nconst t = m.status === "active";',
			),
		).toHaveLength(1);
		// A block closing before the test: the test is in the enclosing scope's other branch.
		expect(
			bad(
				'if (a) {\n\tconst m = await getMembership(u, c);\n\tuse(m);\n} else {\n\tif (m.status === "active") {}\n}',
			),
		).toHaveLength(1);
		// A window that redeclares the variable tests the other one.
		expect(
			bad(
				'const m = await getMembership(u, c);\n{\n\tconst m = other;\n\tif (m.status === "active") {}\n}',
			),
		).toHaveLength(1);
	});

	it("reports every use of the name that is not a call, an import or typeof", () => {
		const bad = (text: string, file = "x.ts") =>
			membershipFindings(file, text).length;
		expect(bad('import { getMembership as findRow } from "./guards";')).toBe(1);
		expect(bad('import { x as getMembership } from "./guards";')).toBe(1);
		expect(bad('export { getMembership } from "./guards";')).toBe(1);
		expect(bad("export { getMembership };")).toBe(1);
		expect(bad("const f = getMembership;\nf(u, c);")).toBe(1);
		expect(bad("rows.map(getMembership);")).toBe(1);
		expect(bad("const m = await getMembership?.(u, c);")).toBe(1);
		expect(bad('const f = guards["getMembership"];')).toBe(1);
		expect(bad('const { getMembership } = await import("./guards");')).toBe(1);
		expect(bad("function getMembership(u) {}")).toBe(1);
		// The definition is allowed in guards.ts alone.
		expect(
			bad("export async function getMembership(u: string) {}", DEFINITION_FILE),
		).toBe(0);
	});

	it("accepts a plain import, typeof, and the comment that quotes a call", () => {
		const none = (text: string) => membershipFindings("x.ts", text);
		expect(none('import { getMembership } from "./guards";')).toEqual([]);
		expect(
			none('import {\n\ta,\n\tgetMembership,\n\tb,\n} from "./guards";'),
		).toEqual([]);
		expect(none('import { a, getMembership } from "./guards";')).toEqual([]);
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

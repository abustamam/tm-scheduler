/**
 * `people.preferred_contact` is read only through `effectivePreferredContact`
 * (#1093), and the has-a-digit test it shares with the roster has one copy.
 *
 * The column can hold a STALE value — SMS chosen, then the phone removed — and
 * that is kept on purpose so restoring the phone brings it back. A surface that
 * reads the column raw shows "prefers SMS" for a member with no phone, and
 * nothing else fails: the value is a valid enum, typecheck is happy, and every
 * existing test's fixture has a phone.
 *
 * The per-reader check parses each reader file with the TypeScript compiler
 * API (an earlier regex version was fooled by template literals, destructuring
 * expressions and long patterns). In each file allowed to read the column:
 *
 *  - every `people.preferredContact` is the initializer of a property
 *    assignment with a plain identifier name — the ALIAS — and the number of
 *    such assignments the parser finds equals the number of textual
 *    `people.preferredContact` mentions in the comment-stripped source, so a
 *    mention the walk did not classify fails;
 *  - each such select lies inside a function (declaration, arrow, function
 *    expression or method); the nearest one is its SCOPE;
 *  - inside that scope, every identifier spelled like the alias must be one
 *    of: the select's own property name; a property access `x.alias` that is a
 *    direct argument of a call to `effectivePreferredContact`; a bare `alias`
 *    that is such an argument; or a binding element of an object binding
 *    pattern that binds the alias under its own name, with no initializer, no
 *    property rename and no computed key. Anything else — a shorthand property
 *    in an object literal, an access used as a default value or computed key,
 *    a renamed binding, a property key — is a failure. Because every
 *    same-named identifier in the scope is checked, a destructured binding's
 *    later uses are held to the same rule;
 *  - each select's scope passes its alias to `effectivePreferredContact` at
 *    least once.
 *
 * What it still cannot see, so the `*preferred-contact*` integration suites
 * are the behavioural gate for these:
 *  - a whole selected row spread or returned (`{ ...row }`, `return row`), or
 *    the row object aliased (`const r2 = row`) and the value read through the
 *    new name outside the checked spellings: the value escapes without the
 *    alias appearing anywhere the walk inspects;
 *  - the alias read OUTSIDE the select's scope, e.g. by a caller of the
 *    function that returned the row;
 *  - the alias read by a string key (`row["stored"]`);
 *  - a `select()` of the whole `people` row, which carries the column without
 *    naming it. The merge reconcile does that and only WRITES the value back
 *    (`people-merge-logic.ts`); no such reader returns it to a client today.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { readSource } from "#/test/guard-source";

vi.mock("#/db", () => ({ db: {} }));

const SRC = resolve(__dirname, "..");
const HELPER = "effectivePreferredContact";

/** Every non-test source file under `src/`. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
			out.push(full);
	}
	return out;
}

const COLUMN = /people\.preferredContact\b|preferred_contact/;

/** Each file allowed to name the column, and what it does with it. */
const ALLOWED: Record<string, "declares" | "reads"> = {
	"db/schema.ts": "declares",
	"server/contact-preference-logic.ts": "reads",
	"server/club-logic.ts": "reads",
	// The admin writer's locked read, logged as the effective value.
	"server/members-logic.ts": "reads",
};

function unwrap(node: ts.Expression): ts.Expression {
	let n = node;
	while (
		ts.isParenthesizedExpression(n) ||
		ts.isAsExpression(n) ||
		ts.isNonNullExpression(n) ||
		ts.isSatisfiesExpression(n)
	) {
		n = n.expression;
	}
	return n;
}

/** `people.preferredContact`, the column as Drizzle spells it. */
function isColumn(node: ts.Expression): boolean {
	const n = unwrap(node);
	return (
		ts.isPropertyAccessExpression(n) &&
		ts.isIdentifier(n.expression) &&
		n.expression.text === "people" &&
		n.name.text === "preferredContact"
	);
}

type FunctionLike =
	| ts.FunctionDeclaration
	| ts.ArrowFunction
	| ts.FunctionExpression
	| ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		ts.isMethodDeclaration(node)
	);
}

function nearestFunction(node: ts.Node): FunctionLike | null {
	for (let n = node.parent; n; n = n.parent) if (isFunctionLike(n)) return n;
	return null;
}

/** Is `node` (an expression) a direct argument of `effectivePreferredContact(…)`? */
function isHelperArgument(node: ts.Node): boolean {
	const call = node.parent;
	return (
		!!call &&
		ts.isCallExpression(call) &&
		ts.isIdentifier(call.expression) &&
		call.expression.text === HELPER &&
		call.arguments.some((a) => a === node)
	);
}

function forEachDescendant(root: ts.Node, visit: (n: ts.Node) => void) {
	const walk = (n: ts.Node) => {
		visit(n);
		ts.forEachChild(n, walk);
	};
	ts.forEachChild(root, walk);
}

/**
 * Classify one identifier spelled like the alias, inside the select's scope.
 * Returns "helper" when it feeds `effectivePreferredContact`, "ok" when it is
 * allowed but does not itself resolve (the select key, a plain binding), or a
 * description of why it is a raw read.
 */
function classify(
	id: ts.Identifier,
	select: ts.PropertyAssignment,
): "helper" | "ok" | string {
	const parent = id.parent;
	if (parent === select && select.name === id) return "ok";
	if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
		return isHelperArgument(parent) ? "helper" : "property access";
	}
	if (ts.isBindingElement(parent)) {
		if (parent.name !== id) return "renamed binding";
		const clean =
			ts.isObjectBindingPattern(parent.parent) &&
			!parent.propertyName &&
			!parent.initializer &&
			!parent.dotDotDotToken;
		return clean ? "ok" : "binding with initializer or rest";
	}
	if (ts.isShorthandPropertyAssignment(parent)) return "shorthand property";
	if (
		(ts.isPropertyAssignment(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isPropertySignature(parent)) &&
		parent.name === id
	) {
		return "property key";
	}
	if (ts.isParameter(parent) || ts.isVariableDeclaration(parent)) {
		return "declared as a variable";
	}
	return isHelperArgument(id) ? "helper" : "bare reference";
}

interface ReaderReport {
	/** Selects found by the AST walk. */
	selects: number;
	/** Textual `people.preferredContact` mentions, comments stripped. */
	mentions: number;
	problems: string[];
}

/** The per-reader check, on one file's source. */
function checkReaderSource(
	fileName: string,
	text: string,
	commentStripped: string,
): ReaderReport {
	const sf = ts.createSourceFile(
		fileName,
		text,
		ts.ScriptTarget.Latest,
		true,
		fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const problems: string[] = [];
	let selects = 0;
	const where = (n: ts.Node) =>
		`${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

	forEachDescendant(sf, (node) => {
		if (!ts.isPropertyAccessExpression(node) || !isColumn(node)) return;
		const select = node.parent;
		if (
			!ts.isPropertyAssignment(select) ||
			unwrap(select.initializer) !== node
		) {
			problems.push(`${where(node)}: column read outside a select key`);
			return;
		}
		selects++;
		if (!ts.isIdentifier(select.name)) {
			problems.push(`${where(node)}: select key is not a plain identifier`);
			return;
		}
		const alias = select.name.text;
		const scope = nearestFunction(select);
		if (!scope) {
			problems.push(`${where(node)}: select outside any function`);
			return;
		}
		let resolved = 0;
		forEachDescendant(scope, (n) => {
			if (!ts.isIdentifier(n) || n.text !== alias) return;
			const verdict = classify(n, select);
			if (verdict === "helper") resolved++;
			else if (verdict !== "ok")
				problems.push(`${where(n)}: ${alias} ${verdict}`);
		});
		if (resolved === 0) {
			problems.push(`${where(node)}: ${alias} never reaches ${HELPER}`);
		}
	});

	const mentions = [...commentStripped.matchAll(/people\.preferredContact\b/g)]
		.length;
	return { selects, mentions, problems };
}

/** For unit cases: one snippet, no comments to strip. */
function check(snippet: string): ReaderReport {
	return checkReaderSource("snippet.ts", snippet, snippet);
}

describe("preferred contact reads (#1093)", () => {
	const files = sourceFiles(SRC);

	it("only the known files name the column", () => {
		expect(files.length).toBeGreaterThan(100);
		const naming = files
			.filter((f) => COLUMN.test(readSource(f)))
			.map((f) => relative(SRC, f))
			.sort();
		expect(naming).toEqual(Object.keys(ALLOWED).sort());
	});

	it("every select of the column is resolved through the helper in its own function", () => {
		let selects = 0;
		for (const [file, role] of Object.entries(ALLOWED)) {
			if (role !== "reads") continue;
			const full = join(SRC, file);
			const report = checkReaderSource(
				file,
				readFileSync(full, "utf8"),
				readSource(full),
			);
			expect(report.problems, file).toEqual([]);
			// Every textual mention is a select the walk classified.
			expect(report.selects, `${file}: unclassified mention`).toBe(
				report.mentions,
			);
			selects += report.selects;
		}
		// loadMyContactPreference, loadClubContactPreferences, loadClubMembers,
		// loadMemberProfile and applyMemberEdit's locked read today. A floor
		// against a walk that silently found nothing, in which case the
		// per-file problem lists would be empty too.
		expect(selects).toBeGreaterThanOrEqual(5);
	});

	describe("checkReaderSource", () => {
		const select = (rest: string) => `
			async function reader() {
				const [row] = await db
					.select({ email: people.email, stored: people.preferredContact })
					.from(people);
				${rest}
			}`;

		it("accepts the helper on a property access", () => {
			expect(
				check(select("return effectivePreferredContact(row.stored, row);"))
					.problems,
			).toEqual([]);
		});

		it("accepts a long multiline destructure whose binding only feeds the helper", () => {
			const report = check(
				select(`
				const {
					stored,
					email,
					aVeryLongFieldNameThatPushesThePatternWellPastEightyCharacters,
					anotherFieldThatMakesThisPatternSpanSeveralLinesOfSource,
					...everythingElseOnTheRowThatTheCallerMightWant
				} = row;
				return effectivePreferredContact(stored, { email, phone: null });`),
			);
			expect(report.problems).toEqual([]);
			expect(report.selects).toBe(1);
		});

		it("accepts an arrow-parameter destructure", () => {
			expect(
				check(
					select(
						"return [row].map(({ stored, ...r }) => effectivePreferredContact(stored, r));",
					),
				).problems,
			).toEqual([]);
		});

		it.each([
			[
				"a raw property access",
				"void effectivePreferredContact(row.stored, row);\nreturn row.stored;",
			],
			[
				"an object-literal shorthand",
				"void effectivePreferredContact(row.stored, row);\nconst { stored, ...rest } = row;\nreturn { stored, ...rest };",
			],
			[
				"a default initializer",
				"const { copied = row.stored } = {};\nreturn effectivePreferredContact(row.stored, row) ?? copied;",
			],
			[
				"a computed key",
				"const { [row.stored]: v } = {};\nreturn effectivePreferredContact(row.stored, row) ?? v;",
			],
			[
				"a renamed binding",
				"void effectivePreferredContact(row.stored, row);\nconst { stored: s } = row;\nreturn s;",
			],
			[
				"a column-zero const inside a template literal",
				"const t = `\nconst x = 1;\n`;\nvoid t;\nreturn effectivePreferredContact(row.stored, row) ?? row.stored;",
			],
			["no helper at all", "return null;"],
		])("rejects %s", (label, rest) => {
			const { problems } = check(select(rest));
			expect(problems.length).toBeGreaterThan(0);
			// Each case but the last resolves the alias legitimately once, so
			// what fails it is the shape under test, not a missing helper call.
			if (label !== "no helper at all") {
				expect(problems.join("\n")).not.toMatch(/never reaches/);
			}
		});

		it("rejects a select outside any function", () => {
			expect(
				check(
					"export const q = db.select({ stored: people.preferredContact });",
				).problems.length,
			).toBeGreaterThan(0);
		});
	});

	it("hasDialablePhone is declared once, in the shared module, and the roster imports it", () => {
		const declaring = files
			.filter((f) =>
				/\bfunction\s+hasDialablePhone\b|\bhasDialablePhone\s*=/.test(
					readSource(f),
				),
			)
			.map((f) => relative(SRC, f));
		expect(declaring).toEqual(["lib/preferred-contact.ts"]);
		const roster = readSource(join(SRC, "routes/_authed/roster.tsx"));
		expect(roster).toMatch(
			/import\s*\{[^}]*\bhasDialablePhone\b[^}]*\}\s*from\s*"#\/lib\/preferred-contact"/,
		);
	});

	it("the pg enum is built from CONTACT_METHODS, which imports nothing", async () => {
		const { CONTACT_METHODS } = await import("#/lib/preferred-contact");
		const { contactMethodEnum, people } = await import("#/db/schema");
		expect([...contactMethodEnum.enumValues]).toEqual([...CONTACT_METHODS]);
		expect(people.preferredContact.enumValues).toEqual([...CONTACT_METHODS]);
		// schema.ts is read by drizzle-kit and bundled into the standalone
		// runners, so a module it value-imports must pull in no graph.
		const lib = readSource(join(SRC, "lib/preferred-contact.ts"));
		expect(lib).not.toMatch(/^\s*import\b/m);
		expect(readSource(join(SRC, "db/schema.ts"))).toMatch(
			/pgEnum\("contact_method",\s*CONTACT_METHODS\)/,
		);
	});
});

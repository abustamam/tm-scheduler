/**
 * The area health reader reads no person column (#1117).
 *
 * `area-health-logic.ts` is the one reader that crosses clubs, so it is the
 * one place a person's name, email or phone could leave a club it does not
 * belong to. The response test (`area-health-logic.integration.test.ts`) fails
 * when a marker value reaches the JSON, but a column that is read and then
 * dropped, or read only on a branch the fixture never takes, passes it. This
 * guard is the query-level half: it fails on what the module is ABLE to read,
 * whether or not the value is returned.
 *
 * It catches a read written plainly or by mistake, not a determined author:
 * `eval` and the like are out of scope, so do not read this as a sandbox.
 *
 * WHAT IT CHECKS, on the module's syntax tree (the TypeScript compiler API, not
 * a text search, because a text search is bypassed by an import written after a
 * comment on the same line, or by an alias):
 *
 * 1. IMPORTS. The module may import only the tables, drizzle helpers and pure
 *    modules listed below. No alias (`as`), no namespace or default import, no
 *    side-effect import, no dynamic `import()`, `require`, `import x = require`,
 *    import type or re-export. An aliased table is a table the later rules can
 *    no longer name, so aliases are refused outright.
 * 2. THREE NAMES, BY POSITION. `db`, `sql` and `members` are each an ALLOWLIST
 *    of the only places they may stand, not a list of bad uses; any other place
 *    is a violation. Every route to a column that does not name it (a
 *    destructure, a bind, an assignment, a helper that takes the table) goes
 *    through one of them in a place the list does not allow.
 *    - `db`: only as the receiver of `.select(` or `.selectDistinct(`, called
 *      at once. Never assigned, destructured, passed, spread, bound,
 *      element-accessed, or used for anything else (`db.query`, a write).
 *    - `sql`: only as the tag of a template. Any other tag is refused too.
 *    - `members`, the one table with a person's name on it: as `members.id`,
 *      `members.clubId` or `members.status` (and nothing read off that), in a
 *      projection value, as the argument of a condition helper (`eq`,
 *      `inArray`, ...) or of `.groupBy` / `.orderBy`, or in a `sql` template
 *      substitution; or as the first argument of a `from` / join that is part
 *      of a chain rooted at `db.select(...)`.
 * 3. READING COLUMNS WITHOUT NAMING THEM. A `select` takes a projection object
 *    with no spread. A `from` / join is called on a chain rooted at
 *    `db.select(...)` and takes an imported table or a subquery declared in
 *    this file as `db.select(...)...as(...)`, never an expression. `.query`,
 *    `$client` and `execute` are refused on any receiver.
 * 4. RAW SQL TEXT. The literal text of every `sql` template may use only a
 *    short vocabulary of aggregate and window function words (`SQL_WORDS`), no
 *    quote, dot or semicolon. A word outside it could be a column (`name`), a
 *    table (`members_email_backup`) or a subquery (`select`), so it is refused.
 *    Values come in through `${}`, which this does not read: they are drizzle
 *    columns and parameters, and a roster column among them is rule 2's.
 *
 * WHAT IT DOES NOT CHECK. The columns of the other allowed tables (`clubs`,
 * `areaClubs`, `meetings`, ...). None carries a person today. A person column
 * added to one of them, and selected, is not caught here; only the response
 * test catches it, and only if its fixture holds a marker in that column.
 * Allowing a table here is a claim about its columns, so review any change to
 * one.
 *
 * READS RAW, not through `readSource`: this is an offender sweep ("the list of
 * violations must be empty"), where blanking comments could only hide a real
 * statement. The syntax tree makes that moot for the checks above (a comment is
 * not a node); the file is still read as written.
 *
 * Every rule below is run against deliberately offending copies of the real
 * source, and a last test fails if a rule has no such case, so a rule that
 * stops matching fails here rather than going quiet.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const LOGIC_PATH = "src/server/area-health-logic.ts";

/** What `#/db/schema` may supply: the tables the issue names, and no others. */
const ALLOWED_SCHEMA_NAMES = new Set([
	"clubs",
	"areaClubs",
	"areas",
	"divisions",
	"meetings",
	"roleSlots",
	"meetingAttendance",
	"officerTerms",
	"members",
	"officerTrainingRecords",
	"officerTrainingPeriods",
	"dcpScoreboards",
	"dcpGoalProgress",
	"duesPeriods",
	"memberDues",
]);

/** Pure modules the logic may call. Nothing from `./` or `#/server/`. */
const ALLOWED_PURE_MODULES = new Set([
	"#/lib/area-health",
	"#/lib/area-health-fields",
	"#/lib/dcp",
	"#/lib/dues",
	"#/lib/officer-training",
	"#/lib/club-archive",
]);

/**
 * The drizzle condition builders. A roster column may be passed to these, and
 * to nothing else that is not a method of a `db.select` chain.
 */
const CONDITION_HELPERS = new Set([
	"and",
	"asc",
	"count",
	"desc",
	"eq",
	"gt",
	"gte",
	"inArray",
	"isNotNull",
	"isNull",
	"lt",
	"lte",
	"ne",
	"not",
	"or",
]);

/**
 * Everything the module may import from drizzle-orm: the builders and the `sql`
 * tag; not `getTableColumns` or `getTableConfig`, which return every column.
 * `SQL` is a type and must be imported as one.
 */
const ALLOWED_DRIZZLE_NAMES = new Set([...CONDITION_HELPERS, "sql", "SQL"]);

/** The only columns of the roster table the module may name. */
const ALLOWED_MEMBER_COLUMNS = new Set(["id", "clubId", "status"]);

/**
 * The words the literal text of an `sql` template may use: the aggregate and
 * window functions and the connectives the module's fragments are built from.
 * A new one belongs here only if it cannot name a column, a table or a
 * subquery.
 */
const SQL_WORDS = new Set([
	"and",
	"by",
	"coalesce",
	"count",
	"distinct",
	"filter",
	"is",
	"max",
	"not",
	"null",
	"order",
	"over",
	"partition",
	"row_number",
	"sum",
	"where",
]);

const SELECT_NAMES = new Set(["select", "selectDistinct"]);
const JOIN_NAMES = new Set([
	"from",
	"innerJoin",
	"leftJoin",
	"rightJoin",
	"fullJoin",
	"crossJoin",
]);
/** Methods of a `db.select` chain that take a column to group or order by. */
const COLUMN_METHODS = new Set(["groupBy", "orderBy"]);
const RAW_ACCESS_NAMES = new Set(["query", "$client", "execute"]);

const RULES = [
	"import-not-allowed",
	"import-alias",
	"import-namespace-or-default",
	"import-side-effect",
	"import-bypass",
	"db-use",
	"sql-use",
	"sql-text",
	"members-column",
	"members-use",
	"select-projection",
	"from-argument",
	"relational-or-raw-api",
] as const;
type Rule = (typeof RULES)[number];

interface Violation {
	rule: Rule;
	text: string;
}

interface Analysis {
	violations: Violation[];
	/** The names imported from `#/db/schema`, for the floor below. */
	schemaNames: string[];
	/** The `select` calls seen, for the floor below. */
	selects: number;
}

const isNamed = (node: ts.Node, name: string): node is ts.Identifier =>
	ts.isIdentifier(node) && node.text === name;

/**
 * Does this expression, read back through its calls and property accesses, start
 * at `db.select(` or `db.selectDistinct(`? True for `db.select({...}).from(t)`
 * and for each link of a chain hanging off it.
 */
function rootsAtDbSelect(expression: ts.Expression): boolean {
	let current: ts.Expression = expression;
	let innermost: string | null = null;
	for (;;) {
		if (ts.isCallExpression(current)) {
			current = current.expression;
		} else if (ts.isPropertyAccessExpression(current)) {
			innermost = current.name.text;
			current = current.expression;
		} else {
			break;
		}
	}
	return (
		isNamed(current, "db") && innermost !== null && SELECT_NAMES.has(innermost)
	);
}

/** Every way `source` breaks the rules, read off its syntax tree. */
function analyze(source: string): Analysis {
	const file = ts.createSourceFile(
		"area-health-logic.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const violations: Violation[] = [];
	const schemaNames: string[] = [];
	/** Imported tables, then subqueries declared in this file. */
	const joinTargets = new Set<string>();
	let selects = 0;

	const report = (node: ts.Node, rule: Rule, message: string) => {
		const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
		violations.push({ rule, text: `line ${line + 1}: ${message}` });
	};

	const checkImport = (decl: ts.ImportDeclaration) => {
		const module = ts.isStringLiteral(decl.moduleSpecifier)
			? decl.moduleSpecifier.text
			: "";
		const clause = decl.importClause;
		if (!clause) {
			report(decl, "import-side-effect", `side-effect import of ${module}`);
			return;
		}
		if (clause.name) {
			report(
				decl,
				"import-namespace-or-default",
				`default import from ${module}`,
			);
		}
		const bindings = clause.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) {
			report(
				decl,
				"import-namespace-or-default",
				`namespace import of ${module} reaches everything it exports`,
			);
		}
		const names: { name: string; typeOnly: boolean; node: ts.Node }[] = [];
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (element.propertyName) {
					report(
						element,
						"import-alias",
						`aliases ${element.propertyName.text} as ${element.name.text}; an alias hides which table or helper a later use means`,
					);
				}
				names.push({
					name: (element.propertyName ?? element.name).text,
					typeOnly: clause.isTypeOnly || element.isTypeOnly,
					node: element,
				});
			}
		}

		if (module === "drizzle-orm") {
			for (const { name, typeOnly, node } of names) {
				if (!ALLOWED_DRIZZLE_NAMES.has(name)) {
					report(
						node,
						"import-not-allowed",
						`imports ${name} from drizzle-orm, which is not on the allowlist`,
					);
				} else if (name === "SQL" && !typeOnly) {
					report(
						node,
						"import-not-allowed",
						"imports SQL from drizzle-orm as a value; it is a type",
					);
				}
			}
		} else if (module === "#/db") {
			for (const { name, node } of names) {
				if (name !== "db") {
					report(
						node,
						"import-not-allowed",
						`imports ${name} from #/db; only db may be`,
					);
				}
			}
		} else if (module === "#/db/schema") {
			for (const { name, node } of names) {
				schemaNames.push(name);
				if (ALLOWED_SCHEMA_NAMES.has(name)) {
					joinTargets.add(name);
				} else {
					report(
						node,
						"import-not-allowed",
						`imports ${name} from #/db/schema, which is not on the allowlist`,
					);
				}
			}
		} else if (!ALLOWED_PURE_MODULES.has(module)) {
			report(
				decl,
				"import-not-allowed",
				`imports ${module}, which is not on the allowlist`,
			);
		}
	};

	// Imports first, so a table is known to be allowed before a `from` names it.
	for (const statement of file.statements) {
		if (ts.isImportDeclaration(statement)) checkImport(statement);
	}
	// A subquery is a local declared as `db.select(...)...as(...)`: a name a
	// `from` / join may take. Found before the walk for the same reason.
	const findSubqueries = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isCallExpression(node.initializer) &&
			ts.isPropertyAccessExpression(node.initializer.expression) &&
			node.initializer.expression.name.text === "as" &&
			rootsAtDbSelect(node.initializer.expression.expression)
		) {
			joinTargets.add(node.name.text);
		}
		ts.forEachChild(node, findSubqueries);
	};
	findSubqueries(file);

	const checkCall = (node: ts.CallExpression) => {
		const callee = node.expression;
		if (callee.kind === ts.SyntaxKind.ImportKeyword) {
			report(node, "import-bypass", "a dynamic import bypasses the allowlist");
		}
		if (isNamed(callee, "require")) {
			report(node, "import-bypass", "require bypasses the allowlist");
		}
		if (!ts.isPropertyAccessExpression(callee)) return;
		const name = callee.name.text;
		if (SELECT_NAMES.has(name) && isNamed(callee.expression, "db")) {
			selects++;
			const projection = node.arguments[0];
			if (!projection || !ts.isObjectLiteralExpression(projection)) {
				report(
					node,
					"select-projection",
					"a select with no projection object reads every column",
				);
			} else if (projection.properties.some(ts.isSpreadAssignment)) {
				report(
					node,
					"select-projection",
					"a spread in a projection can pull in every column",
				);
			}
		} else if (name === "selectDistinctOn") {
			report(
				node,
				"select-projection",
				"selectDistinctOn is not a projection object",
			);
		}
		if (JOIN_NAMES.has(name) && !isNamed(callee.expression, "Array")) {
			const target = node.arguments[0];
			if (!rootsAtDbSelect(callee.expression)) {
				report(
					node,
					"from-argument",
					`${name}() must be called on a chain that starts at db.select(...)`,
				);
			} else if (
				!target ||
				!ts.isIdentifier(target) ||
				!joinTargets.has(target.text)
			) {
				report(
					node,
					"from-argument",
					`${name}() must take an imported table or a subquery declared here as db.select(...)...as(...), not an expression or another name`,
				);
			}
		}
	};

	const checkAccess = (node: ts.PropertyAccessExpression) => {
		const name = node.name.text;
		if (RAW_ACCESS_NAMES.has(name)) {
			report(
				node,
				"relational-or-raw-api",
				`.${name} is the relational query API, the pg client or a raw statement, and reads every column`,
			);
		}
	};

	const checkTemplate = (node: ts.TaggedTemplateExpression) => {
		if (!isNamed(node.tag, "sql")) {
			report(
				node,
				"sql-use",
				"a template tag other than sql; its text would not be read",
			);
			return;
		}
		const template = node.template;
		const pieces = ts.isNoSubstitutionTemplateLiteral(template)
			? [template.text]
			: [
					template.head.text,
					...template.templateSpans.map((s) => s.literal.text),
				];
		const unknown = new Set<string>();
		for (const piece of pieces) {
			for (const match of piece.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
				if (!SQL_WORDS.has(match[0].toLowerCase())) unknown.add(match[0]);
			}
		}
		if (unknown.size > 0) {
			report(
				node,
				"sql-text",
				`sql text uses ${[...unknown].map((w) => `"${w}"`).join(", ")}, outside the allowed vocabulary: it could name a column, a table or a subquery`,
			);
		}
		if (pieces.some((piece) => /["'`.;]/.test(piece))) {
			report(
				node,
				"sql-text",
				"sql text contains a quote, a dot or a semicolon, which can name a column or table",
			);
		}
	};

	/** May `members.<column>` stand where it stands? */
	const memberColumnPositionAllowed = (
		access: ts.PropertyAccessExpression,
	): boolean => {
		const parent = access.parent;
		// A projection value: `{ clubId: members.clubId }`.
		if (ts.isPropertyAssignment(parent) && parent.initializer === access) {
			return true;
		}
		// An argument of a condition helper, or of a group / order of a chain.
		if (ts.isCallExpression(parent) && parent.arguments.includes(access)) {
			const callee = parent.expression;
			if (ts.isIdentifier(callee)) return CONDITION_HELPERS.has(callee.text);
			return (
				ts.isPropertyAccessExpression(callee) &&
				COLUMN_METHODS.has(callee.name.text) &&
				rootsAtDbSelect(callee.expression)
			);
		}
		// A substitution in an sql template.
		return (
			ts.isTemplateSpan(parent) &&
			parent.expression === access &&
			ts.isTemplateExpression(parent.parent) &&
			ts.isTaggedTemplateExpression(parent.parent.parent) &&
			isNamed(parent.parent.parent.tag, "sql")
		);
	};

	const checkIdentifier = (node: ts.Identifier) => {
		if (node.text !== "members" && node.text !== "sql" && node.text !== "db") {
			return;
		}
		const parent = node.parent;
		// A property name is not a reference to the imported binding.
		if (
			(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
			(ts.isPropertyAssignment(parent) && parent.name === node) ||
			(ts.isBindingElement(parent) && parent.propertyName === node)
		) {
			return;
		}

		if (node.text === "db") {
			const call = parent.parent;
			const allowed =
				ts.isPropertyAccessExpression(parent) &&
				parent.expression === node &&
				SELECT_NAMES.has(parent.name.text) &&
				ts.isCallExpression(call) &&
				call.expression === parent;
			if (!allowed) {
				report(
					node,
					"db-use",
					"db used other than as the receiver of a called .select( or .selectDistinct(",
				);
			}
			return;
		}

		if (node.text === "sql") {
			if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return;
			report(
				node,
				"sql-use",
				ts.isPropertyAccessExpression(parent) && parent.expression === node
					? `sql.${parent.name.text} is not a template tag; sql may be used only as one`
					: "sql used other than as a template tag",
			);
			return;
		}

		// members
		if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
			const column = parent.name.text;
			if (!ALLOWED_MEMBER_COLUMNS.has(column)) {
				report(
					node,
					"members-column",
					`reads members.${column}; only id, clubId and status may be named`,
				);
			} else if (!memberColumnPositionAllowed(parent)) {
				report(
					node,
					"members-use",
					`members.${column} is used where only a projection value, a condition helper's argument, a group / order column or an sql substitution may stand`,
				);
			}
			return;
		}
		if (
			ts.isCallExpression(parent) &&
			parent.arguments[0] === node &&
			ts.isPropertyAccessExpression(parent.expression) &&
			JOIN_NAMES.has(parent.expression.name.text) &&
			rootsAtDbSelect(parent.expression.expression)
		) {
			return;
		}
		report(
			node,
			"members-use",
			"members used other than as members.id, members.clubId or members.status, or as the table of a from / join on a db.select chain",
		);
	};

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			// Its identifiers are the import list, not uses: checked once, above.
			return;
		}
		if (ts.isImportEqualsDeclaration(node)) {
			report(node, "import-bypass", "import = require bypasses the allowlist");
		}
		if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			report(node, "import-bypass", "a re-export bypasses the allowlist");
		}
		if (ts.isImportTypeNode(node)) {
			report(node, "import-bypass", "an import() type bypasses the allowlist");
		}
		if (ts.isCallExpression(node)) checkCall(node);
		if (ts.isPropertyAccessExpression(node)) checkAccess(node);
		if (ts.isTaggedTemplateExpression(node)) checkTemplate(node);
		if (ts.isIdentifier(node)) checkIdentifier(node);
		ts.forEachChild(node, visit);
	};
	visit(file);

	return { violations, schemaNames, selects };
}

const SOURCE = readFileSync(LOGIC_PATH, "utf8");

/** `SOURCE` with `snippet` as the first statements of `loadAreaHealth`. */
function insideLoadAreaHealth(snippet: string): string {
	const file = ts.createSourceFile(
		"area-health-logic.ts",
		SOURCE,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const declaration = file.statements.find(
		(s): s is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(s) && s.name?.text === "loadAreaHealth",
	);
	if (!declaration?.body) {
		throw new Error("area-health-logic.ts no longer declares loadAreaHealth");
	}
	const at = declaration.body.getStart(file) + 1;
	return `${SOURCE.slice(0, at)}\n${snippet}\n${SOURCE.slice(at)}`;
}

describe("area-health-logic.ts reads no person column (#1117)", () => {
	it("imports only the allowlist, keeps db, sql and members to their allowed places, projects every select and keeps raw SQL to a short vocabulary", () => {
		const analysis = analyze(SOURCE);
		// The floor: a parser that found no imports and no selects would call an
		// empty module clean. This asks only that the module still has any.
		expect(analysis.schemaNames.length).toBeGreaterThan(0);
		expect(analysis.selects).toBeGreaterThan(0);

		expect(analysis.violations.map((v) => v.text)).toEqual([]);
	});

	describe("each rule fails on the offence it exists for", () => {
		// A copy of the real source with the offence added, so the rest of the
		// file is the real one and the only new thing is what is being tested.
		const atEnd = (snippet: string) => `${SOURCE}\n${snippet}\n`;

		type Case = [label: string, source: () => string, rule: Rule];
		const end = (label: string, snippet: string, rule: Rule): Case => [
			label,
			() => atEnd(snippet),
			rule,
		];
		const inside = (label: string, snippet: string, rule: Rule): Case => [
			label,
			() => insideLoadAreaHealth(snippet),
			rule,
		];

		const cases: Case[] = [
			// --- imports ---------------------------------------------------
			end(
				"a table outside the allowlist",
				'import { people } from "#/db/schema";',
				"import-not-allowed",
			),
			end(
				"the email backup table",
				'import { membersEmailBackup } from "#/db/schema";',
				"import-not-allowed",
			),
			end(
				"the phone backup table",
				'import { membersPhoneBackup } from "#/db/schema";',
				"import-not-allowed",
			),
			end(
				"a table imported after a comment on the same line",
				'/* extra */ import { people } from "#/db/schema";',
				"import-not-allowed",
			),
			end(
				"the roster table aliased, then read",
				'import { members as roster } from "#/db/schema";\nconst leak = { who: roster.name };',
				"import-alias",
			),
			end(
				"a drizzle helper aliased",
				'import { sql as q } from "drizzle-orm";',
				"import-alias",
			),
			end(
				"the whole schema as a namespace",
				'import * as schema from "#/db/schema";',
				"import-namespace-or-default",
			),
			end(
				"the schema as a default import",
				'import schema from "#/db/schema";',
				"import-namespace-or-default",
			),
			end(
				"drizzle-orm as a namespace",
				'import * as orm from "drizzle-orm";',
				"import-namespace-or-default",
			),
			end(
				"drizzle-orm as a default import",
				'import orm from "drizzle-orm";',
				"import-namespace-or-default",
			),
			end(
				"a drizzle helper that returns every column",
				'import { getTableColumns } from "drizzle-orm";',
				"import-not-allowed",
			),
			end(
				"the SQL class imported as a value",
				'import { SQL } from "drizzle-orm";',
				"import-not-allowed",
			),
			end(
				"something other than db from #/db",
				'import { schema } from "#/db";',
				"import-not-allowed",
			),
			end(
				"another server module",
				'import { currentOfficersForClub } from "./officers-logic";',
				"import-not-allowed",
			),
			end(
				"a server module through the alias",
				'import { loadTrainingRecords } from "#/server/officer-training-logic";',
				"import-not-allowed",
			),
			end(
				"a pure module that is not on the list",
				'import { personName } from "#/lib/person-name";',
				"import-not-allowed",
			),
			end(
				"a type-only import from a module that is not on the list",
				'import type { PersonName } from "#/lib/person-name";',
				"import-not-allowed",
			),
			end(
				"a side-effect import",
				'import "./side-effect";',
				"import-side-effect",
			),
			end(
				"a dynamic import of a loader",
				'const topUp = await import("./schedule-topup-logic");',
				"import-bypass",
			),
			end(
				"require",
				'const leak = require("./officers-logic");',
				"import-bypass",
			),
			end(
				"import = require",
				'import legacy = require("./officers-logic");',
				"import-bypass",
			),
			end(
				"an import() type",
				'type Leak = import("#/db/schema").Person;',
				"import-bypass",
			),
			end(
				"a re-export from the schema",
				'export { people } from "#/db/schema";',
				"import-bypass",
			),
			// --- db: only `db.select(` ----------------------------------------
			end(
				"the relational query API",
				"const leak = await db.query.members.findMany();",
				"db-use",
			),
			end(
				"the relational query API by string",
				'const leak = db["query"];',
				"db-use",
			),
			end(
				"a raw statement through db",
				"const leak = await db.execute(sql`select 1`);",
				"db-use",
			),
			end("the pg client through db", "const leak = db.$client;", "db-use"),
			end("an insert", "await db.insert(clubs).values({});", "db-use"),
			end("an update", "await db.update(clubs).set({});", "db-use"),
			end("a delete", "await db.delete(clubs);", "db-use"),
			end("a transaction", "await db.transaction(async () => {});", "db-use"),
			end("db assigned", "const reader = db;", "db-use"),
			end("db passed to a function", "helper(db);", "db-use"),
			end("db spread", "const copy = { ...db };", "db-use"),
			inside(
				"the relational API through a destructure of db (Codex 1a)",
				"const { query: relational } = db; await relational.people.findMany({ columns: { email: true } });",
				"db-use",
			),
			inside(
				"the relational API through an alias of db and a string key (Codex 1b)",
				'const reader = db; await reader["query"].people.findMany({ columns: { email: true } });',
				"db-use",
			),
			inside(
				"db.select bound, then called (Codex 5)",
				"const read = db.select.bind(db); await read().from(members);",
				"db-use",
			),
			// --- sql: only as a tag ---------------------------------------------
			end("sql.raw", 'const leak = sql.raw("select 1");', "sql-use"),
			end("sql.identifier", 'const leak = sql.identifier("email");', "sql-use"),
			end("sql taken out of its tag", "const { raw } = sql;", "sql-use"),
			end("sql assigned", "const tag = sql;", "sql-use"),
			end(
				"a template tag other than sql",
				"const leak = other`select email from people`;",
				"sql-use",
			),
			inside(
				"sql bound to a new tag, which the text check would not read (Codex 2)",
				"const fragment = sql.bind(null); db.select({ email: fragment`(select email from people limit 1)` }).from(clubs);",
				"sql-use",
			),
			// --- sql text -------------------------------------------------------
			end(
				"a subquery of the people table in sql text",
				"const leak = { privateEmail: sql<string>`(select email from people limit 1)` };",
				"sql-text",
			),
			end(
				"a backup table named in sql text",
				"const leak = sql<string>`members_email_backup.email`;",
				"sql-text",
			),
			end(
				"a bare column named in sql text",
				"const leak = sql<string>`name`;",
				"sql-text",
			),
			end(
				"a quoted identifier in sql text",
				'const leak = sql<string>`"email"`;',
				"sql-text",
			),
			end(
				"a whole-table star in sql text",
				"const leak = sql`${clubs}.*`;",
				"sql-text",
			),
			end(
				"select star in sql text",
				"const leak = sql`select * from clubs`;",
				"sql-text",
			),
			// --- the roster table -----------------------------------------------
			end(
				"a name column of the roster table",
				"const leak = { who: members.name };",
				"members-column",
			),
			end(
				"a preferred name column of the roster table",
				"const leak = { who: members.preferredName };",
				"members-column",
			),
			end(
				"a roster column named by a string",
				'const leak = { who: members["name"] };',
				"members-use",
			),
			end(
				"the roster table aliased to dodge the column rule",
				"const roster = members;",
				"members-use",
			),
			end(
				"the roster table destructured",
				"const { name } = members;",
				"members-use",
			),
			end(
				"the roster table as a shorthand property",
				"const leak = { members };",
				"members-use",
			),
			end(
				"the roster table spread into a projection",
				"const leak = db.select({ ...members }).from(clubs);",
				"members-use",
			),
			end(
				"an allowed roster column with something read off it",
				"const leak = members.id.table;",
				"members-use",
			),
			end(
				"an allowed roster column cast and kept",
				"const leak = members.clubId as any;",
				"members-use",
			),
			end(
				"an allowed roster column passed to a function that is not a helper",
				"const leak = reach(members.status);",
				"members-use",
			),
			end(
				"the roster table passed to a function that is not a from or join",
				"const leak = reach(members);",
				"members-use",
			),
			inside(
				"the table read off an allowed column, then used (Codex 3)",
				"const roster = members.id.table as any; db.select({ name: roster.name }).from(members);",
				"members-use",
			),
			inside(
				"the roster table passed through a helper named from (Codex 4)",
				"const helper = { from<T>(t: T) { return t; } }; const roster = helper.from(members); db.select({ name: roster.name }).from(roster);",
				"members-use",
			),
			// --- reading columns without naming them -----------------------------
			end(
				"a projection-less select from the roster table",
				"const leak = await db.select().from(members);",
				"select-projection",
			),
			end(
				"a select of a variable",
				"const leak = await db.select(columns).from(clubs);",
				"select-projection",
			),
			end(
				"a spread in a projection",
				"const leak = await db.select({ ...columns, id: clubs.id }).from(clubs);",
				"select-projection",
			),
			end(
				"selectDistinctOn",
				"const leak = await db.selectDistinctOn([clubs.id], { id: clubs.id }).from(clubs);",
				"select-projection",
			),
			end(
				"a from of an expression",
				"const leak = await db.select({ id: clubs.id }).from(sql`clubs`);",
				"from-argument",
			),
			end(
				"a join of an expression",
				"const leak = await db.select({ id: clubs.id }).from(clubs).innerJoin(other(), eq(clubs.id, clubs.id));",
				"from-argument",
			),
			end(
				"a from of a name that is not a table or a subquery",
				"const leak = await db.select({ id: clubs.id }).from(roster);",
				"from-argument",
			),
			end(
				"a from called on something that is not a db.select chain",
				"const leak = helper.from(clubs);",
				"from-argument",
			),
			end(
				"the pg client, the relational API or a raw statement on another receiver",
				"const leak = somethingElse.query;",
				"relational-or-raw-api",
			),
		];

		it.each(cases)("%s", (_label, source, rule) => {
			const rules = analyze(source()).violations.map((v) => v.rule);
			expect(rules, `expected a ${rule} violation`).toContain(rule);
		});

		it("has an offending-copy case for every rule", () => {
			// The header's claim, held: a rule added to RULES with no case fails here.
			const covered = new Set(cases.map(([, , rule]) => rule));
			expect([...RULES].filter((rule) => !covered.has(rule))).toEqual([]);
		});

		it("does not flag the shapes the module legitimately uses", () => {
			const fine = [
				'import { and, count, eq, type SQL, sql } from "drizzle-orm";',
				'import { db } from "#/db";',
				'import { meetings, members } from "#/db/schema";',
				'import { areaLabel } from "#/lib/area-health-fields";',
				// A projection, a join on the roster table, group and where on it.
				"const a = db.select({ id: members.id }).from(members);",
				"const b = db.select({ c: members.clubId }).from(meetings).innerJoin(members, eq(meetings.id, members.id));",
				"const c = db.select({ n: count() }).from(members).where(eq(members.status, 'active'));",
				"const d = await db.select({ c: members.clubId, n: count() }).from(members).where(and(eq(members.status, 'active'), inArray(members.clubId, ids))).groupBy(members.clubId);",
				"const e = { members: 1 };",
				// A subquery and a select from it, as the module's attendance and
				// next-meeting queries are.
				"const sub = db.select({ clubId: meetings.clubId, n: sql<number>`count(*) filter (where ${eq(meetings.status, 'x')} and ${meetings.id} is not null)`.mapWith(Number).as('n') }).from(meetings).groupBy(meetings.clubId, meetings.id).as('sub');",
				"const f = await db.select({ clubId: sub.clubId, total: sql<number>`coalesce(sum(${sub.n}), 0)`.mapWith(Number) }).from(sub).groupBy(sub.clubId);",
				"const g = sql<number>`row_number() over (partition by ${meetings.clubId} order by ${meetings.scheduledAt}, ${meetings.id})`.as('place');",
				"const h = sql<Date | null>`max(${meetings.scheduledAt}) filter (where ${isHeld})`.mapWith(meetings.scheduledAt);",
				"const i = sql<number>`count(distinct ${members.status})`.mapWith(Number);",
				"const j = Array.from(new Set([1]));",
				"const [k] = await db.select({ n: meetings.id }).from(meetings).where(eq(meetings.id, id));",
			].join("\n");
			expect(analyze(fine).violations.map((v) => v.text)).toEqual([]);
		});
	});
});

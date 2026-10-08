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
 * WHAT IT CHECKS, on the module's syntax tree (the TypeScript compiler API, not
 * a text search, because a text search is bypassed by an import written after a
 * comment on the same line, or by an alias):
 *
 * 1. IMPORTS. The module may import only the tables, drizzle helpers and pure
 *    modules listed below. No alias (`as`), no namespace or default import, no
 *    side-effect import, no dynamic `import()`, `require`, `import x = require`,
 *    import type or re-export. An aliased table is a table the later rules can
 *    no longer name, so aliases are refused outright.
 * 2. THE ROSTER TABLE. `members` is the one table with a person's name on it.
 *    It may appear only as `members.id`, `members.clubId`, `members.status`, or
 *    as the table of a `.from()` / `.xJoin()`. Anything else (another column,
 *    `members["name"]`, `const roster = members`, a spread) fails.
 * 3. READING COLUMNS WITHOUT NAMING THEM. A `select` must take a projection
 *    object with no spread. A `from` / join must take a named table or
 *    subquery, never an expression. The relational query API, the raw
 *    `execute`, the pg client and the writes (`insert`, `update`, `delete`,
 *    `transaction`) are refused.
 * 4. RAW SQL TEXT. `sql` is allowed only as a template tag, and the literal
 *    text of every `sql` template may use only a short vocabulary of aggregate
 *    and window function words (`SQL_WORDS`), no quote, dot or semicolon. A
 *    word outside it could be a column (`name`), a table
 *    (`members_email_backup`) or a subquery (`select`), so it is refused;
 *    `sql.raw` and `sql.identifier` are refused too. Values come in through
 *    `${}`, which this does not read: they are drizzle columns and parameters.
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
 * The drizzle helpers the module may import. Condition builders and the `sql`
 * tag; not `getTableColumns` or `getTableConfig`, which return every column.
 * `SQL` is a type and must be imported as one.
 */
const ALLOWED_DRIZZLE_NAMES = new Set([
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
	"sql",
	"SQL",
]);

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

const JOIN_NAMES = new Set([
	"from",
	"innerJoin",
	"leftJoin",
	"rightJoin",
	"fullJoin",
	"crossJoin",
]);
const DB_WRITE_NAMES = new Set(["insert", "update", "delete", "transaction"]);
const RAW_ACCESS_NAMES = new Set(["query", "$client", "execute"]);

const RULES = [
	"import-not-allowed",
	"import-alias",
	"import-namespace-or-default",
	"import-side-effect",
	"import-bypass",
	"members-column",
	"members-use",
	"select-projection",
	"from-argument",
	"relational-or-raw-api",
	"db-write",
	"sql-use",
	"sql-text",
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
				if (!ALLOWED_SCHEMA_NAMES.has(name)) {
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
		if (name === "select" || name === "selectDistinct") {
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
			if (!target || !ts.isIdentifier(target)) {
				report(
					node,
					"from-argument",
					`${name}() must take a named table or subquery, not an expression`,
				);
			}
		}
		if (isNamed(callee.expression, "db") && DB_WRITE_NAMES.has(name)) {
			report(node, "db-write", `db.${name} writes; this reader is read-only`);
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
		if (
			isNamed(node.expression, "sql") &&
			(name === "raw" || name === "identifier")
		) {
			report(node, "sql-use", `sql.${name} can name any column or table`);
		}
	};

	const checkSqlText = (node: ts.TaggedTemplateExpression) => {
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

	const checkIdentifier = (node: ts.Identifier) => {
		if (node.text !== "members" && node.text !== "sql") return;
		const parent = node.parent;
		// A property name is not a reference to the imported binding.
		if (
			(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
			(ts.isPropertyAssignment(parent) && parent.name === node) ||
			(ts.isBindingElement(parent) && parent.propertyName === node)
		) {
			return;
		}
		if (node.text === "members") {
			if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
				if (!ALLOWED_MEMBER_COLUMNS.has(parent.name.text)) {
					report(
						node,
						"members-column",
						`reads members.${parent.name.text}; only id, clubId and status may be named`,
					);
				}
				return;
			}
			if (
				ts.isCallExpression(parent) &&
				parent.arguments[0] === node &&
				ts.isPropertyAccessExpression(parent.expression) &&
				JOIN_NAMES.has(parent.expression.name.text)
			) {
				return;
			}
			report(
				node,
				"members-use",
				"uses members other than as members.id, members.clubId, members.status or a joined table",
			);
			return;
		}
		if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return;
		// `sql.raw` and `sql.identifier` are reported where they are accessed.
		if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
			return;
		}
		report(node, "sql-use", "sql used other than as a template tag");
	};

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			// Its identifiers are the import list, not uses: checked once, here.
			checkImport(node);
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
		if (
			ts.isElementAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			["db", "sql", "members"].includes(node.expression.text)
		) {
			report(
				node,
				node.expression.text === "members"
					? "members-column"
					: "relational-or-raw-api",
				`${node.expression.text}[...] names a member by a string the other rules cannot read`,
			);
		}
		if (ts.isTaggedTemplateExpression(node) && isNamed(node.tag, "sql")) {
			checkSqlText(node);
		}
		if (ts.isIdentifier(node)) checkIdentifier(node);
		ts.forEachChild(node, visit);
	};
	visit(file);

	return { violations, schemaNames, selects };
}

const SOURCE = readFileSync(LOGIC_PATH, "utf8");

describe("area-health-logic.ts reads no person column (#1117)", () => {
	it("imports only the allowlist, names only members.id, clubId and status, projects every select and keeps raw SQL to a short vocabulary", () => {
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
		const withSnippet = (snippet: string) => `${SOURCE}\n${snippet}\n`;

		const cases: [label: string, snippet: string, rule: Rule][] = [
			// --- imports ---------------------------------------------------
			[
				"a table outside the allowlist",
				'import { people } from "#/db/schema";',
				"import-not-allowed",
			],
			[
				"the email backup table",
				'import { membersEmailBackup } from "#/db/schema";',
				"import-not-allowed",
			],
			[
				"the phone backup table",
				'import { membersPhoneBackup } from "#/db/schema";',
				"import-not-allowed",
			],
			[
				"a table imported after a comment on the same line",
				'/* extra */ import { people } from "#/db/schema";',
				"import-not-allowed",
			],
			[
				"the roster table aliased, then read",
				'import { members as roster } from "#/db/schema";\nconst leak = { who: roster.name };',
				"import-alias",
			],
			[
				"a drizzle helper aliased",
				'import { sql as q } from "drizzle-orm";',
				"import-alias",
			],
			[
				"the whole schema as a namespace",
				'import * as schema from "#/db/schema";',
				"import-namespace-or-default",
			],
			[
				"the schema as a default import",
				'import schema from "#/db/schema";',
				"import-namespace-or-default",
			],
			[
				"drizzle-orm as a namespace",
				'import * as orm from "drizzle-orm";',
				"import-namespace-or-default",
			],
			[
				"drizzle-orm as a default import",
				'import orm from "drizzle-orm";',
				"import-namespace-or-default",
			],
			[
				"a drizzle helper that returns every column",
				'import { getTableColumns } from "drizzle-orm";',
				"import-not-allowed",
			],
			[
				"the SQL class imported as a value",
				'import { SQL } from "drizzle-orm";',
				"import-not-allowed",
			],
			[
				"something other than db from #/db",
				'import { schema } from "#/db";',
				"import-not-allowed",
			],
			[
				"another server module",
				'import { currentOfficersForClub } from "./officers-logic";',
				"import-not-allowed",
			],
			[
				"a server module through the alias",
				'import { loadTrainingRecords } from "#/server/officer-training-logic";',
				"import-not-allowed",
			],
			[
				"a pure module that is not on the list",
				'import { personName } from "#/lib/person-name";',
				"import-not-allowed",
			],
			[
				"a type-only import from a module that is not on the list",
				'import type { PersonName } from "#/lib/person-name";',
				"import-not-allowed",
			],
			["a side-effect import", 'import "./side-effect";', "import-side-effect"],
			[
				"a dynamic import of a loader",
				'const topUp = await import("./schedule-topup-logic");',
				"import-bypass",
			],
			["require", 'const leak = require("./officers-logic");', "import-bypass"],
			[
				"import = require",
				'import legacy = require("./officers-logic");',
				"import-bypass",
			],
			[
				"an import() type",
				'type Leak = import("#/db/schema").Person;',
				"import-bypass",
			],
			[
				"a re-export from the schema",
				'export { people } from "#/db/schema";',
				"import-bypass",
			],
			// --- the roster table --------------------------------------------
			[
				"a name column of the roster table",
				"const leak = { who: members.name };",
				"members-column",
			],
			[
				"a preferred name column of the roster table",
				"const leak = { who: members.preferredName };",
				"members-column",
			],
			[
				"a roster column named by a string",
				'const leak = { who: members["name"] };',
				"members-column",
			],
			[
				"the roster table aliased to dodge the column rule",
				"const roster = members;",
				"members-use",
			],
			[
				"the roster table destructured",
				"const { name } = members;",
				"members-use",
			],
			[
				"the roster table as a shorthand property",
				"const leak = { members };",
				"members-use",
			],
			[
				"the roster table spread into a projection",
				"const leak = db.select({ ...members }).from(clubs);",
				"members-use",
			],
			// --- reading columns without naming them -------------------------
			[
				"a projection-less select from the roster table",
				"const leak = await db.select().from(members);",
				"select-projection",
			],
			[
				"a select of a variable",
				"const leak = await db.select(columns).from(clubs);",
				"select-projection",
			],
			[
				"a spread in a projection",
				"const leak = await db.select({ ...columns, id: clubs.id }).from(clubs);",
				"select-projection",
			],
			[
				"selectDistinctOn",
				"const leak = await db.selectDistinctOn([clubs.id], { id: clubs.id }).from(clubs);",
				"select-projection",
			],
			[
				"a from of an expression",
				"const leak = await db.select({ id: clubs.id }).from(sql`clubs`);",
				"from-argument",
			],
			[
				"a join of an expression",
				"const leak = await db.select({ id: clubs.id }).from(clubs).innerJoin(other(), eq(clubs.id, clubs.id));",
				"from-argument",
			],
			[
				"the relational query API",
				"const leak = await db.query.members.findMany();",
				"relational-or-raw-api",
			],
			[
				"the relational query API by string",
				'const leak = db["query"];',
				"relational-or-raw-api",
			],
			[
				"a raw statement",
				"const leak = await db.execute(sql`select 1`);",
				"relational-or-raw-api",
			],
			["the pg client", "const leak = db.$client;", "relational-or-raw-api"],
			["an insert", "await db.insert(clubs).values({});", "db-write"],
			["an update", "await db.update(clubs).set({});", "db-write"],
			["a delete", "await db.delete(clubs);", "db-write"],
			["a transaction", "await db.transaction(async () => {});", "db-write"],
			// --- raw SQL ------------------------------------------------------
			[
				"a subquery of the people table in sql text",
				"const leak = { privateEmail: sql<string>`(select email from people limit 1)` };",
				"sql-text",
			],
			[
				"a backup table named in sql text",
				"const leak = sql<string>`members_email_backup.email`;",
				"sql-text",
			],
			[
				"a bare column named in sql text",
				"const leak = sql<string>`name`;",
				"sql-text",
			],
			[
				"a quoted identifier in sql text",
				'const leak = sql<string>`"email"`;',
				"sql-text",
			],
			[
				"a whole-table star in sql text",
				"const leak = sql`${clubs}.*`;",
				"sql-text",
			],
			[
				"select star in sql text",
				"const leak = sql`select * from clubs`;",
				"sql-text",
			],
			["sql.raw", 'const leak = sql.raw("select 1");', "sql-use"],
			["sql.identifier", 'const leak = sql.identifier("email");', "sql-use"],
			["sql taken out of its tag", "const { raw } = sql;", "sql-use"],
		];

		it.each(cases)("%s", (_label, snippet, rule) => {
			const rules = analyze(withSnippet(snippet)).violations.map((v) => v.rule);
			expect(rules, `expected a ${rule} violation`).toContain(rule);
		});

		it("has an offending-copy case for every rule", () => {
			// The header's claim, held: a rule added to RULES with no case fails here.
			const covered = new Set(cases.map(([, , rule]) => rule));
			expect([...RULES].filter((rule) => !covered.has(rule))).toEqual([]);
		});

		it("does not flag the shapes the module legitimately uses", () => {
			const fine = [
				'import { and, eq, type SQL, sql } from "drizzle-orm";',
				'import { db } from "#/db";',
				'import { members, meetings } from "#/db/schema";',
				'import { areaLabel } from "#/lib/area-health-fields";',
				"const a = db.select({ id: members.id }).from(members);",
				"const b = db.select({ c: members.clubId }).from(meetings).innerJoin(members, eq(meetings.id, members.id));",
				"const c = db.select({ n: count() }).from(members).where(eq(members.status, 'active'));",
				"const d = { members: 1 };",
				"const e = sql<number>`count(*) filter (where ${x} and ${y} is not null)`;",
				"const f = sql<number>`row_number() over (partition by ${a} order by ${b}, ${c})`;",
				"const g = sql<number>`coalesce(sum(${a}), 0)`;",
				"const h = Array.from(new Set([1]));",
			].join("\n");
			expect(analyze(fine).violations).toEqual([]);
		});
	});
});

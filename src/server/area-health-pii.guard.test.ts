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
 * THE IMPORT ALLOWLIST IS THE GUARD. A grep for column names is bypassed by
 * `db.select().from(members)` and `db.query.members`, which read every column
 * without naming one, and by tables a ban list never named, such as
 * `members_email_backup` and `members_phone_backup`. So the module may import
 * only the tables below, and a table it does not import cannot leak, whatever
 * its columns are called. The rules after it close the ways to read a column
 * without naming it from a table that IS imported.
 *
 * READS RAW, not through `readSource`: this is an offender sweep ("the list of
 * violations must be empty"), where blanking comments could only hide a real
 * statement, and a comment that trips a rule can only fail loudly. The cost is
 * that `area-health-logic.ts` must not spell a banned pattern in a comment;
 * the failure message names the line.
 *
 * Each rule is also run against deliberately offending copies of the real
 * source below, so a regex that stops matching fails here rather than going
 * quiet.
 */
import { readFileSync } from "node:fs";
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

/** The only columns of the roster table the module may name. */
const ALLOWED_MEMBER_COLUMNS = new Set(["id", "clubId", "status"]);

/** Helpers that return every column of a table, for a projection to spread. */
const DENIED_DRIZZLE_NAMES = new Set([
	"getTableColumns",
	"getTableConfig",
	"getViewSelectedFields",
]);

const JOINS = "from|innerJoin|leftJoin|rightJoin|fullJoin|crossJoin";

interface Import {
	module: string;
	/** The clause between `import` and `from`, or "" for a bare import. */
	clause: string;
	/** Where the whole statement starts and ends in the source. */
	start: number;
	end: number;
}

/** Every static import, side-effect import and re-export in the source. */
function parseImports(source: string): Import[] {
	const found: Import[] = [];
	const withClause =
		/^(?:import|export)\s+([^;"']*?)\s*from\s*["']([^"']+)["'];?/gm;
	for (const m of source.matchAll(withClause)) {
		found.push({
			module: m[2] as string,
			clause: (m[1] as string).trim(),
			start: m.index,
			end: m.index + m[0].length,
		});
	}
	const bare = /^import\s+["']([^"']+)["'];?/gm;
	for (const m of source.matchAll(bare)) {
		found.push({
			module: m[1] as string,
			clause: "",
			start: m.index,
			end: m.index + m[0].length,
		});
	}
	return found;
}

/** `{ a, type B, c as d }` to `["a", "B", "c"]`; null when it is not a braced list. */
function namedImports(clause: string): string[] | null {
	const braced = /^(?:type\s+)?\{([\s\S]*)\}$/.exec(clause);
	if (!braced) return null;
	return (braced[1] as string)
		.split(",")
		.map((part) => part.trim().replace(/^type\s+/, ""))
		.filter(Boolean)
		.map((part) => (part.split(/\s+as\s+/)[0] as string).trim());
}

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

/** Every way `source` breaks the rules, as sentences naming the line. */
function violations(source: string): string[] {
	const found: string[] = [];
	const at = (index: number) => `line ${lineOf(source, index)}`;

	// --- Imports ---------------------------------------------------------
	const imports = parseImports(source);
	for (const imp of imports) {
		const where = at(imp.start);
		const names = namedImports(imp.clause);
		if (imp.module === "drizzle-orm") {
			if (names === null) {
				found.push(`${where}: imports drizzle-orm other than as a named list`);
				continue;
			}
			for (const name of names) {
				if (DENIED_DRIZZLE_NAMES.has(name)) {
					found.push(`${where}: imports ${name}, which returns every column`);
				}
			}
		} else if (imp.module === "#/db") {
			if (names === null || names.some((n) => n !== "db")) {
				found.push(`${where}: imports from #/db anything but { db }`);
			}
		} else if (imp.module === "#/db/schema") {
			if (names === null) {
				found.push(
					`${where}: imports #/db/schema as a namespace or default, which reaches every table`,
				);
				continue;
			}
			for (const name of names) {
				if (!ALLOWED_SCHEMA_NAMES.has(name)) {
					found.push(
						`${where}: imports ${name} from #/db/schema, which is not on the allowlist`,
					);
				}
			}
		} else if (!ALLOWED_PURE_MODULES.has(imp.module)) {
			found.push(
				`${where}: imports ${imp.module}, which is not on the allowlist`,
			);
		}
	}

	// The rest is read with the import statements blanked, so the schema import
	// list does not count as a use of a table.
	let body = source;
	for (const imp of imports) {
		body =
			body.slice(0, imp.start) +
			body.slice(imp.start, imp.end).replace(/[^\n]/g, " ") +
			body.slice(imp.end);
	}

	for (const m of body.matchAll(/\bimport\s*\(/g)) {
		found.push(`${at(m.index)}: a dynamic import bypasses the allowlist`);
	}
	for (const m of body.matchAll(/\brequire\s*\(/g)) {
		found.push(`${at(m.index)}: require bypasses the allowlist`);
	}

	// --- The roster table: id, club and status, and nothing else ----------
	for (const m of body.matchAll(/\bmembers\b/g)) {
		const after = body.slice(m.index + 7, m.index + 7 + 40);
		const before = body.slice(Math.max(0, m.index - 40), m.index);
		const column = /^\.(\w+)/.exec(after)?.[1];
		if (column !== undefined) {
			if (!ALLOWED_MEMBER_COLUMNS.has(column)) {
				found.push(
					`${at(m.index)}: reads members.${column}; only id, clubId and status may be named`,
				);
			}
			continue;
		}
		const asJoinedTable =
			new RegExp(`\\.(?:${JOINS})\\(\\s*$`).test(before) &&
			/^\s*[,)]/.test(after);
		if (!asJoinedTable) {
			found.push(
				`${at(m.index)}: uses members other than as members.id, members.clubId, members.status or a joined table`,
			);
		}
	}

	// --- Reading columns without naming them ------------------------------
	for (const m of body.matchAll(
		/\.(?:select|selectDistinct|selectDistinctOn)\(\s*[^\s{]/g,
	)) {
		found.push(
			`${at(m.index)}: a select with no projection object reads every column`,
		);
	}
	for (const m of body.matchAll(/\.query\b/g)) {
		found.push(`${at(m.index)}: the relational query API reads every column`);
	}
	for (const m of body.matchAll(/\bsql\s*\.\s*raw\b/g)) {
		found.push(`${at(m.index)}: sql.raw can read anything`);
	}
	for (const m of body.matchAll(/\.execute\s*\(/g)) {
		found.push(`${at(m.index)}: a raw statement can read anything`);
	}
	for (const m of body.matchAll(/select\s+(?:distinct\s+)?\*/gi)) {
		found.push(`${at(m.index)}: select * reads every column`);
	}
	for (const m of body.matchAll(/[\w"`})]\.\*/g)) {
		found.push(`${at(m.index)}: table.* reads every column`);
	}
	return found;
}

const SOURCE = readFileSync(LOGIC_PATH, "utf8");

describe("area-health-logic.ts reads no person column (#1117)", () => {
	it("imports only the allowlist, names only members.id, clubId and status, and projects every select", () => {
		// The floor: a parser that stopped matching would find no imports and no
		// selects, and "no violations" would be vacuously true.
		const imports = parseImports(SOURCE);
		expect(imports.length).toBeGreaterThanOrEqual(8);
		const schemaNames = imports
			.filter((i) => i.module === "#/db/schema")
			.flatMap((i) => namedImports(i.clause) ?? []);
		expect(schemaNames.length).toBeGreaterThanOrEqual(10);
		expect(schemaNames).toContain("members");
		expect(SOURCE.match(/\.select\(/g)?.length).toBeGreaterThanOrEqual(10);
		expect(SOURCE.match(/\bmembers\./g)?.length).toBeGreaterThanOrEqual(5);

		expect(violations(SOURCE)).toEqual([]);
	});

	describe("each rule fails on the offence it exists for", () => {
		// A copy of the real source with the offence added, so the rest of the
		// file is the real one and the only new thing is what is being tested.
		const withLine = (line: string) => `${SOURCE}\n${line}\n`;

		const cases: [string, string, RegExp][] = [
			[
				"a table outside the allowlist",
				'import { people } from "#/db/schema";',
				/people/,
			],
			[
				"the email backup table",
				'import { membersEmailBackup } from "#/db/schema";',
				/membersEmailBackup/,
			],
			[
				"the phone backup table",
				'import { membersPhoneBackup } from "#/db/schema";',
				/membersPhoneBackup/,
			],
			[
				"the whole schema as a namespace",
				'import * as schema from "#/db/schema";',
				/namespace or default/,
			],
			[
				"another server module",
				'import { currentOfficersForClub } from "./officers-logic";',
				/officers-logic/,
			],
			[
				"a server module through the alias",
				'import { loadTrainingRecords } from "#/server/officer-training-logic";',
				/officer-training-logic/,
			],
			[
				"a pure module that is not on the list",
				'import { personName } from "#/lib/person-name";',
				/person-name/,
			],
			[
				"a dynamic import of a loader",
				'const topUp = await import("./schedule-topup-logic");',
				/dynamic import/,
			],
			[
				"a name column of the roster table",
				"const leak = { who: members.name };",
				/members\.name/,
			],
			[
				"a preferred name column of the roster table",
				"const leak = { who: members.preferredName };",
				/members\.preferredName/,
			],
			[
				"a projection-less select from the roster table",
				"const leak = await db.select().from(members);",
				/no projection object/,
			],
			[
				"the roster table aliased to dodge the column rule",
				"const roster = members;",
				/uses members other than/,
			],
			[
				"the relational query API",
				"const leak = await db.query.members.findMany();",
				/relational query API/,
			],
			["a raw sql fragment", 'const leak = sql.raw("select 1");', /sql\.raw/],
			[
				"a raw statement",
				"const leak = await db.execute(sql`select 1`);",
				/raw statement/,
			],
			["select star", "const leak = sql`select * from clubs`;", /select \*/],
			["a whole-table star", "const leak = sql`${clubs}.*`;", /table\.\*/],
			[
				"a helper that returns every column",
				'import { getTableColumns } from "drizzle-orm";',
				/getTableColumns/,
			],
		];

		it.each(cases)("%s", (_label, line, expected) => {
			const found = violations(withLine(line));
			expect(found.length).toBeGreaterThan(0);
			expect(found.join("\n")).toMatch(expected);
		});

		it("does not flag the shapes the module legitimately uses", () => {
			const fine = [
				'import { and, eq, type SQL } from "drizzle-orm";',
				'import { db } from "#/db";',
				'import { members, meetings } from "#/db/schema";',
				'import { areaLabel } from "#/lib/area-health-fields";',
				"const a = db.select({ id: members.id }).from(members);",
				"const b = db.select({ c: members.clubId }).from(meetings).innerJoin(members, eq(meetings.id, members.id));",
				"const c = db.select({ n: count() }).from(members).where(eq(members.status, 'active'));",
			].join("\n");
			expect(violations(fine)).toEqual([]);
		});
	});
});

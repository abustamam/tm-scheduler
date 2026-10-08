/**
 * The `## Prod check` contract (#1130): a PR whose migration SQL writes rows carries a section of
 * that exact name, and `/review-pr` reports when it is missing.
 *
 * Two things in that contract can drift without anything else going red, and this holds both.
 *
 * ## The heading is one spelling in three documents
 *
 * The PR body, `docs/agents/data-and-deploy.md` and `.claude/skills/review-pr/SKILL.md` meet at
 * the heading `## Prod check`, and `.claude/agents/implementer.md` is how an agent that writes
 * the PR body learns it. Reword it in one and `/review-pr` reports a section as missing that the
 * agent wrote exactly as its brief said. Markdown is outside Biome and `tsc`, so nothing else
 * notices.
 *
 * ## The trigger is a statement, not three words
 *
 * The issue's first wording was "the SQL contains UPDATE, DELETE or INSERT". Read literally that
 * fires on a foreign key (`ON DELETE set null ON UPDATE no action`), which Drizzle writes into
 * almost every migration that adds a table. Measured on 2026-10-08, the bare words appear in 70
 * of 116 migrations and a row-writing statement in 29, so the literal rule would ask for a prod
 * check on a migration like `0115` (six tables, no data touched) and teach reviewers to ignore the
 * line. The pattern below matches a statement: `UPDATE <table>`, `DELETE FROM`, `INSERT INTO`,
 * at the start of a line or after `(`, `)`, `,` or `;`, so a `WITH` or `DO` body still counts and
 * `ON UPDATE`, `FOR UPDATE` and `BEFORE INSERT` do not.
 *
 * The command runs through the real `grep`, not a JavaScript translation of the pattern: the
 * reviewer runs `grep`, and POSIX bracket classes and `\b` are exactly what a hand-translated
 * RegExp would quietly get wrong. A silent pass is the failure to avoid, so a case expected to
 * NOT match asserts exit status 1 ("no match"), never merely "not 0": `grep` exits 2 on a pattern
 * it cannot parse, and that would otherwise read as a clean DDL-only migration.
 *
 * `SKILL.md` must carry the pattern byte for byte. The test cannot run the markdown, so it holds
 * the pattern in this file, asserts the skill contains it, and exercises it here: a change to
 * either side alone turns the suite red.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const HEADING = "## Prod check";

/** A line that begins with `--` is a SQL comment; `/review-pr` drops those before matching. */
const COMMENT_LINE = "^[[:space:]]*--";

/** The pattern in `/review-pr` step 3, for `grep -i -E`. Keep byte-identical to SKILL.md. */
const WRITES_ROWS =
	"(^|[(),;])[[:space:]]*(update[[:space:]]+[^[:space:]]+|delete[[:space:]]+from|insert[[:space:]]+into)\\b";

function read(rel: string): string {
	return readFileSync(resolve(ROOT, rel), "utf8");
}

function grep(args: string[], input: string) {
	const result = spawnSync("grep", args, { input, encoding: "utf8" });
	// 0 = match, 1 = no match, 2 = error. Anything else means the harness is broken.
	expect([0, 1], `grep ${args.join(" ")}: ${result.stderr}`).toContain(
		result.status,
	);
	return result;
}

/** Exactly what `/review-pr` step 3 runs on one migration file's text. */
function writesRows(sql: string): boolean {
	const code = grep(["-v", COMMENT_LINE], sql).stdout;
	return grep(["-i", "-E", "-q", WRITES_ROWS], code).status === 0;
}

describe("the statement pattern", () => {
	it.each([
		["UPDATE", 'UPDATE "people" SET "phone" = NULL;'],
		["lower case", 'update "people" set "phone" = null;'],
		["DELETE FROM", 'DELETE FROM "pathways_projects" p WHERE p.id = 1;'],
		[
			"INSERT INTO",
			'INSERT INTO "people_backup" ("id") SELECT "id" FROM "people";',
		],
		[
			"an UPDATE that names its alias before SET",
			'UPDATE "people" t\nSET "phone" = b."phone"\nFROM "phone_backup" b;',
		],
		[
			"a statement inside a DO block, indented",
			"DO $$\nBEGIN\n\t\tINSERT INTO speeches (id) VALUES (1);\nEND $$;",
		],
		[
			"a one-line CTE that deletes and inserts",
			"WITH m AS (DELETE FROM t RETURNING *) INSERT INTO u SELECT * FROM m;",
		],
		[
			"a CTE whose body carries a FOR UPDATE lock, as 0112 does",
			'WITH moved AS (\n\tSELECT "id" FROM "people"\n\tFOR UPDATE\n)\nINSERT INTO "b" ("id") SELECT "id" FROM moved;',
		],
		[
			"a statement after a drizzle statement-breakpoint",
			'ALTER TABLE "a" ADD COLUMN "b" text;--> statement-breakpoint\nUPDATE "a" SET "b" = \'x\';',
		],
	])("fires on %s", (_label, sql) => {
		expect(writesRows(sql)).toBe(true);
	});

	it.each([
		[
			"a foreign key's referential actions",
			'ALTER TABLE "a" ADD CONSTRAINT "a_b_fk" FOREIGN KEY ("b") REFERENCES "public"."b"("id") ON DELETE set null ON UPDATE no action;',
		],
		[
			"ON DELETE cascade alone",
			'ALTER TABLE "a" ADD CONSTRAINT "x" FOREIGN KEY ("b") REFERENCES "b"("id") ON DELETE cascade;',
		],
		[
			"a FOR UPDATE row lock with no write",
			'SELECT "id" FROM "people" WHERE "id" = 1 FOR UPDATE;',
		],
		[
			"a trigger event",
			"CREATE TRIGGER t\n\tBEFORE INSERT OR UPDATE ON oauth_refresh_token\n\tFOR EACH ROW EXECUTE FUNCTION f();",
		],
		[
			"a statement that is only commented out",
			'-- UPDATE "people" SET "phone" = NULL;\n--   DELETE FROM "people";\nCREATE TABLE "x" ("id" uuid);',
		],
		[
			"plain DDL",
			'CREATE TABLE "areas" ("id" uuid PRIMARY KEY);\nCREATE INDEX "i" ON "areas" ("id");',
		],
		["an empty file", ""],
	])("stays silent on %s", (_label, sql) => {
		expect(writesRows(sql)).toBe(false);
	});
});

describe("the real migrations", () => {
	function migration(prefix: string): string {
		const files = readdirSync(resolve(ROOT, "drizzle")).filter(
			(name) => name.startsWith(`${prefix}_`) && name.endsWith(".sql"),
		);
		if (files.length !== 1) {
			throw new Error(
				`expected one migration ${prefix}, found ${files.length}`,
			);
		}
		return read(`drizzle/${files[0]}`);
	}

	// The week the issue was filed from (2026-09-30..10-07), plus the other row-writing
	// migrations whose shape differs: a snapshot-and-rewrite (0076), a multi-line string literal
	// (0105).
	it.each([
		["0105", "rewrites role_definitions notes"],
		["0107", "backs up and clears members.phone"],
		["0109", "backs up and clears members.email"],
		[
			"0112",
			"#1109, the one the issue is about: rewrites stored +1 phone rows",
		],
		["0114", "backfills contact_preference_by"],
		["0076", "snapshots then clears people.email"],
	])("fires on %s (%s)", (prefix) => {
		expect(writesRows(migration(prefix))).toBe(true);
	});

	// 0106 and 0115 are the cases that matter: each is DDL whose foreign keys carry
	// `ON DELETE ... ON UPDATE no action`, so the issue's literal wording would fire on them.
	it.each([
		["0106", "an enum value, a column and a foreign key, #1065"],
		["0108", "an enum and a column, #1070"],
		["0110", "drops a table and columns, #1095"],
		["0111", "an enum and a column, #1099"],
		["0113", "a column, #1111"],
		["0115", "six tables with foreign keys, #1123"],
		["0087", "a BEFORE INSERT trigger"],
	])("stays silent on %s (%s)", (prefix) => {
		expect(writesRows(migration(prefix))).toBe(false);
	});
});

describe("the heading and the pattern are held between the documents", () => {
	it.each([
		"docs/agents/data-and-deploy.md",
		".claude/skills/review-pr/SKILL.md",
		".claude/agents/implementer.md",
	])("%s names `## Prod check` exactly", (rel) => {
		expect(read(rel)).toContain(`\`${HEADING}\``);
	});

	it("/review-pr step 3 carries the statement pattern and the comment filter byte for byte", () => {
		const skill = read(".claude/skills/review-pr/SKILL.md");
		expect(skill).toContain(`grep -v '${COMMENT_LINE}'`);
		expect(skill).toContain(`grep -i -E -q '${WRITES_ROWS}'`);
	});

	it("data-and-deploy.md says who runs the check, how, and where the result goes", () => {
		const doc = read("docs/agents/data-and-deploy.md");
		expect(doc).toContain("railway ssh --service Postgres -- psql -X -c");
		expect(doc).toContain("never row values");
		expect(doc).toContain("The main session runs it");
	});
});

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
 * notices. Each assertion is anchored inside the construct that carries the instruction (the
 * paragraph, the hint's blockquote, the bullet), because the heading is named in several places in
 * the same file and a whole-file `toContain` stays green when the one operative sentence changes.
 *
 * ## The trigger is the command in `/review-pr` step 3, run for real
 *
 * The reviewer runs a shell command, so this test slices that command's fenced block out of
 * `SKILL.md` and runs it, verbatim, in a throwaway git repository whose `origin/main` and
 * `origin/pr` refs stand in for the PR. Fixture migrations and real ones from `drizzle/` are
 * committed on `pr`, and the command's output says which it flagged. There is no copy of the
 * pattern in this file to drift from the one in the skill, and no JavaScript translation of a
 * POSIX pattern to get quietly wrong.
 *
 * Why the command matches a statement and not the three words, with the numbers, is in `SKILL.md`
 * step 3, which is the one place they are kept. The cases here pin what that prose claims:
 * each shape the pattern is meant to catch has a fixture, and so does each DDL shape it must not
 * fire on, including a foreign key's `ON DELETE ... ON UPDATE no action`, which the issue's first
 * wording ("contains UPDATE, DELETE or INSERT") would have flagged. One fixture pins the accepted
 * false alarm, so the doc's statement that it is accepted stays true.
 *
 * `grep` exits 2 on a pattern it cannot parse. The command must say so rather than read it as "no
 * match", so one test breaks the pattern on purpose and asserts every file is reported as an error.
 * A DDL-only run must print nothing and exit 0.
 */
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "#/test/route-hydration";

const HEADING = "## Prod check";

function read(rel: string): string {
	return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** Text between two markers, which must both exist and enclose something. */
function between(text: string, start: string, end: string | null): string {
	const from = text.indexOf(start);
	expect(from, `"${start}" not found`).toBeGreaterThanOrEqual(0);
	const to =
		end === null ? text.length : text.indexOf(end, from + start.length);
	expect(to, `"${end}" not found after "${start}"`).toBeGreaterThan(from);
	const slice = text.slice(from, to);
	expect(slice.length, `empty slice from "${start}"`).toBeGreaterThan(
		start.length,
	);
	return slice;
}

const SKILL = read(".claude/skills/review-pr/SKILL.md");

/** `/review-pr` step 3, from its heading to step 4's. */
const STEP_3 = between(
	SKILL,
	"### 3. Print the risk-category hint",
	"### 4. Run the two axes",
);

/** The one fenced bash block in step 3: the command the reviewer runs. */
const COMMAND = between(STEP_3, "```bash\n", "\n```")
	.replace("```bash\n", "")
	.replaceAll("<base>", "main")
	.replaceAll("<head>", "pr");

describe("the command in /review-pr step 3", () => {
	it("is the migration listing, not some other block", () => {
		expect(COMMAND).toContain("git diff --name-only --diff-filter=AM");
		expect(COMMAND).toContain("origin/main...origin/pr");
		expect(COMMAND).toContain("'drizzle/*.sql'");
	});
});

/** Environment for git and the command: nothing inherited from a hook or an outer repo. */
const CLEAN_ENV = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync(
		"git",
		[
			"-c",
			"user.name=prod-check-test",
			"-c",
			"user.email=prod-check-test@example.com",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, encoding: "utf8", env: CLEAN_ENV },
	);
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
}

function writeAll(dir: string, files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), sql);
	}
}

/**
 * A repo whose `origin/main` holds `baseFiles` and whose `origin/pr` adds exactly `files` on top
 * of them.
 */
function repoWithPr(
	files: Record<string, string>,
	baseFiles: Record<string, string> = {},
): string {
	const dir = mkdtempSync(join(tmpdir(), "prod-check-"));
	git(dir, "init", "-q", "-b", "main");
	writeAll(dir, { README: "base\n", ...baseFiles });
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
	git(dir, "checkout", "-q", "-b", "pr");
	writeAll(dir, files);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "pr");
	git(dir, "update-ref", "refs/remotes/origin/pr", "HEAD");
	return dir;
}

function runCommand(command: string, cwd: string) {
	const result = spawnSync("bash", ["-c", command], {
		cwd,
		encoding: "utf8",
		env: CLEAN_ENV,
	});
	return {
		status: result.status,
		stderr: result.stderr,
		lines: result.stdout.split("\n").filter((line) => line !== ""),
	};
}

/** Fixture migrations. `fires` is whether the reviewer should be told the SQL writes rows. */
const FIXTURES: ReadonlyArray<{ label: string; sql: string; fires: boolean }> =
	[
		// The statement shapes the doc says it catches.
		{
			label: "UPDATE",
			sql: 'UPDATE "people" SET "phone" = NULL;',
			fires: true,
		},
		{
			label: "lower case update",
			sql: 'update "people" set "phone" = null;',
			fires: true,
		},
		{
			label: "DELETE FROM",
			sql: 'DELETE FROM "pathways_projects" p WHERE p.id = 1;',
			fires: true,
		},
		{
			label: "INSERT INTO",
			sql: 'INSERT INTO "people_backup" ("id") SELECT "id" FROM "people";',
			fires: true,
		},
		{
			label: "an UPDATE that names its alias before SET",
			sql: 'UPDATE "people" t\nSET "phone" = b."phone"\nFROM "phone_backup" b;',
			fires: true,
		},
		{
			label: "a statement after a drizzle statement-breakpoint",
			sql: 'ALTER TABLE "a" ADD COLUMN "b" text;--> statement-breakpoint\nUPDATE "a" SET "b" = \'x\';',
			fires: true,
		},
		{
			label: "a statement in a DO block, indented",
			sql: "DO $$\nBEGIN\n\t\tINSERT INTO speeches (id) VALUES (1);\nEND $$;",
			fires: true,
		},
		{
			label: "a one-line CTE that deletes and inserts",
			sql: "WITH m AS (DELETE FROM t RETURNING *) INSERT INTO u SELECT * FROM m;",
			fires: true,
		},
		{
			label: "a CTE whose body carries a FOR UPDATE lock, as 0112 does",
			sql: 'WITH moved AS (\n\tSELECT "id" FROM "people"\n\tFOR UPDATE\n)\nINSERT INTO "b" ("id") SELECT "id" FROM moved;',
			fires: true,
		},
		// The anchors past the start of a line: one fixture per keyword, so each can be mutated.
		{
			label: "a one-line DO block, UPDATE after BEGIN",
			sql: 'DO $$ BEGIN UPDATE "t" SET "a" = 1; END $$;',
			fires: true,
		},
		{
			label: "DELETE FROM after THEN",
			sql: 'DO $$ BEGIN IF FOUND THEN DELETE FROM "t"; END IF; END $$;',
			fires: true,
		},
		{
			label: "DELETE FROM after ELSE",
			sql: 'DO $$ BEGIN IF x THEN NULL; ELSE DELETE FROM "t"; END IF; END $$;',
			fires: true,
		},
		{
			label: "INSERT INTO after LOOP",
			sql: 'FOR r IN SELECT 1 LOOP INSERT INTO "t" ("a") VALUES (1); END LOOP;',
			fires: true,
		},
		{
			label: "an EXECUTE string",
			sql: 'EXECUTE \'UPDATE "t" SET "a" = 1\';',
			fires: true,
		},
		{
			label: "a format() string",
			sql: "PERFORM format('UPDATE %I SET a = 1', t);",
			fires: true,
		},
		// A keyword at the end of a line: the table, FROM or INTO is on the next one.
		{
			label: "UPDATE with its table on the next line",
			sql: 'UPDATE\n"people" SET "a" = 1;',
			fires: true,
		},
		{
			label: "DELETE with FROM on the next line",
			sql: 'DELETE\nFROM "people";',
			fires: true,
		},
		{
			label: "INSERT with INTO on the next line",
			sql: 'INSERT\nINTO "people" ("a") VALUES (1);',
			fires: true,
		},
		{
			label: "TRUNCATE TABLE",
			sql: 'TRUNCATE TABLE "t" RESTART IDENTITY;',
			fires: true,
		},
		{
			label: "TRUNCATE with its table on the next line",
			sql: 'TRUNCATE\n"t";',
			fires: true,
		},
		// The accepted false alarm: read as `UPDATE no ...`, a statement.
		{
			label:
				"a foreign key whose ON and UPDATE are on separate lines (accepted)",
			sql: 'ALTER TABLE "a" ADD CONSTRAINT "x" FOREIGN KEY ("b") REFERENCES "b"("id") ON DELETE cascade ON\nUPDATE no action;',
			fires: true,
		},
		// DDL, which must stay silent.
		{
			label: "a foreign key's referential actions",
			sql: 'ALTER TABLE "a" ADD CONSTRAINT "a_b_fk" FOREIGN KEY ("b") REFERENCES "public"."b"("id") ON DELETE set null ON UPDATE no action;',
			fires: false,
		},
		{
			label: "ON DELETE cascade alone",
			sql: 'ALTER TABLE "a" ADD CONSTRAINT "x" FOREIGN KEY ("b") REFERENCES "b"("id") ON DELETE cascade;',
			fires: false,
		},
		{
			label: "a FOR UPDATE row lock with no write",
			sql: 'SELECT "id" FROM "people" WHERE "id" = 1 FOR UPDATE;',
			fires: false,
		},
		{
			label: "a trigger event",
			sql: "CREATE TRIGGER t\n\tBEFORE INSERT OR UPDATE ON oauth_refresh_token\n\tFOR EACH ROW EXECUTE FUNCTION f();",
			fires: false,
		},
		{
			label: "statements that are only commented out, each after an anchor",
			sql: '-- (UPDATE "people" SET "phone" = NULL);\n-- ran earlier; DELETE FROM "people";\n-- if x then TRUNCATE "people";\n-- EXECUTE \'INSERT INTO "people" ("id") VALUES (1)\';\nCREATE TABLE "x" ("id" uuid);',
			fires: false,
		},
		{
			label: "identifiers that start with a keyword",
			sql: 'CREATE TABLE "t" (\n\tupdate_count integer,\n\ttruncated_at timestamp,\n\tdeleted_by text,\n\tinsertion_order integer\n);',
			fires: false,
		},
		{
			label: "an enum value that contains a keyword",
			sql: "ALTER TYPE \"public\".\"activity_action\" ADD VALUE 'member_updated' BEFORE 'x';",
			fires: false,
		},
		{
			label: "a CASE with THEN and ELSE and no statement",
			sql: 'ALTER TABLE "x" ADD CONSTRAINT "c" CHECK (CASE WHEN "a" > 0 THEN "b" ELSE "c" END);',
			fires: false,
		},
		{
			label: "plain DDL",
			sql: 'CREATE TABLE "areas" ("id" uuid PRIMARY KEY);\nCREATE INDEX "i" ON "areas" ("id");',
			fires: false,
		},
		{ label: "an empty file", sql: "", fires: false },
	];

/**
 * Real migrations, read from `drizzle/` by their number. The week the issue was filed from
 * (2026-09-30..10-07) plus others whose shape differs: a snapshot-and-rewrite (0076), a
 * multi-line string literal (0105), and two plpgsql DO blocks (0012, 0083).
 */
const REAL: ReadonlyArray<{ prefix: string; why: string; fires: boolean }> = [
	{ prefix: "0105", why: "rewrites role_definitions notes", fires: true },
	{ prefix: "0107", why: "backs up and clears members.phone", fires: true },
	{ prefix: "0109", why: "backs up and clears members.email", fires: true },
	{
		prefix: "0112",
		why: "#1109, the one the issue is about: rewrites stored +1 phone rows",
		fires: true,
	},
	{
		prefix: "0114",
		why: "backfills contact_preference_by",
		fires: true,
	},
	{ prefix: "0076", why: "snapshots then clears people.email", fires: true },
	{ prefix: "0012", why: "a plpgsql DO block backfill", fires: true },
	{ prefix: "0083", why: "a plpgsql DO block rekeying roles", fires: true },
	{
		prefix: "0106",
		why: "an enum value, a column and a foreign key, #1065",
		fires: false,
	},
	{ prefix: "0108", why: "an enum and a column, #1070", fires: false },
	{ prefix: "0110", why: "drops a table and columns, #1095", fires: false },
	{ prefix: "0111", why: "an enum and a column, #1099", fires: false },
	{ prefix: "0113", why: "a column, #1111", fires: false },
	{
		prefix: "0115",
		why: "six tables with foreign keys, #1123",
		fires: false,
	},
	{ prefix: "0087", why: "a BEFORE INSERT trigger", fires: false },
];

function realMigration(prefix: string): { name: string; sql: string } {
	const dir = join(REPO_ROOT, "drizzle");
	const found = readdirSync(dir).filter(
		(name) => name.startsWith(`${prefix}_`) && name.endsWith(".sql"),
	);
	if (found.length !== 1) {
		throw new Error(`expected one migration ${prefix}, found ${found.length}`);
	}
	return { name: found[0], sql: readFileSync(join(dir, found[0]), "utf8") };
}

const fixtureFile = (index: number) =>
	`drizzle/9${String(index).padStart(3, "0")}_fixture.sql`;

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("what the command flags", () => {
	const files: Record<string, string> = {};
	FIXTURES.forEach((fixture, index) => {
		files[fixtureFile(index)] = fixture.sql;
	});
	for (const real of REAL) {
		const { name, sql } = realMigration(real.prefix);
		files[`drizzle/${name}`] = sql;
	}
	let flagged: Set<string>;
	let output: ReturnType<typeof runCommand>;

	beforeAll(() => {
		const dir = repoWithPr(files);
		dirs.push(dir);
		output = runCommand(COMMAND, dir);
		flagged = new Set(output.lines);
	});

	it("runs clean: exit 0, nothing on stderr, no pattern error", () => {
		expect(output.stderr).toBe("");
		expect(output.status).toBe(0);
		expect(
			output.lines.filter((line) => line.startsWith("grep error")),
		).toEqual([]);
	});

	it.each(
		FIXTURES.map((fixture, index) => ({ ...fixture, index })),
	)("$label: fires=$fires", ({ index, fires }) => {
		expect(flagged.has(fixtureFile(index))).toBe(fires);
	});

	it.each(REAL)("migration $prefix ($why): fires=$fires", ({
		prefix,
		fires,
	}) => {
		expect(flagged.has(`drizzle/${realMigration(prefix).name}`)).toBe(fires);
	});
});

describe("the exit codes", () => {
	it("reports a pattern grep cannot parse as an error for every file, never as no match", () => {
		const dir = repoWithPr({
			"drizzle/9000_a.sql": 'CREATE TABLE "a" ("id" uuid);',
			"drizzle/9001_b.sql": 'UPDATE "a" SET "id" = NULL;',
		});
		dirs.push(dir);
		const broken = COMMAND.replace('lead="(^|', 'lead="((^|');
		expect(broken).not.toBe(COMMAND);
		const { lines } = runCommand(broken, dir);
		expect(lines.sort()).toEqual([
			"grep error: drizzle/9000_a.sql",
			"grep error: drizzle/9001_b.sql",
		]);
	});

	it("prints nothing and exits 0 for a DDL-only PR", () => {
		const dir = repoWithPr({
			"drizzle/9000_a.sql":
				'CREATE TABLE "a" ("id" uuid);--> statement-breakpoint\nALTER TABLE "a" ADD CONSTRAINT "f" FOREIGN KEY ("id") REFERENCES "b"("id") ON DELETE set null ON UPDATE no action;',
		});
		dirs.push(dir);
		const { lines, status, stderr } = runCommand(COMMAND, dir);
		expect(lines).toEqual([]);
		expect(stderr).toBe("");
		expect(status).toBe(0);
	});

	it("flags a file the PR adds and ignores a data-changing one it does not touch", () => {
		const dir = repoWithPr(
			{ "drizzle/9000_a.sql": 'DELETE FROM "a";' },
			{ "drizzle/8000_old.sql": 'UPDATE "a" SET "id" = NULL;' },
		);
		dirs.push(dir);
		expect(runCommand(COMMAND, dir).lines).toEqual(["drizzle/9000_a.sql"]);
	});
});

describe("the heading is the same operative instruction in each document", () => {
	it("data-and-deploy.md tells the PR author to head the section exactly so", () => {
		const doc = read("docs/agents/data-and-deploy.md");
		const paragraph = between(doc, "**What the PR carries.**", "**Who runs it");
		expect(paragraph).toContain(`A section headed exactly \`${HEADING}\``);
	});

	it("/review-pr step 3 names it in both lines it can print", () => {
		const missing = between(
			STEP_3,
			"- **A file printed and `body`",
			"- **A file printed and the body has",
		);
		expect(missing).toContain(`PR body has no \`${HEADING}\` section`);
		const present = between(
			STEP_3,
			"- **A file printed and the body has",
			"`src/test/prod-check-contract",
		);
		expect(present).toContain(`the PR body carries a \`${HEADING}\``);
	});

	it("the implementer's bullet for a data-changing migration names it", () => {
		const doc = read(".claude/agents/implementer.md");
		const bullet = between(
			doc,
			"- A migration whose SQL changes data",
			"\n- ",
		).replace(/\s+/g, " ");
		expect(bullet).toContain(`needs a \`${HEADING}\` section in the PR body`);
	});

	it("data-and-deploy.md says who runs the check, how, and where the result goes", () => {
		const doc = read("docs/agents/data-and-deploy.md");
		expect(doc).toContain("railway ssh --service Postgres -- psql -X -c");
		expect(doc).toContain("never row values");
		expect(doc).toContain("The main session runs it");
	});
});

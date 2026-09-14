/**
 * No identifier in a committed migration may exceed Postgres' 63-byte limit
 * (#723).
 *
 * Postgres does not ERROR on a long identifier — it emits a `NOTICE` and
 * silently TRUNCATES to 63 bytes. That is why this needs a test rather than
 * trusting the database to complain: the notice scrolls past in a migration
 * that otherwise succeeds, and every gate downstream stays green.
 *
 * What the truncation actually costs, which is not obvious: `db:migrate` is
 * fine (it applies once, and CI's drift check compares `schema.ts` against the
 * snapshot JSON, both of which hold the UNtruncated name). `db:push` is not.
 * It introspects the LIVE database, reads back the truncated name, fails to
 * match the name drizzle derives from the schema, and therefore reissues
 * `DROP CONSTRAINT` + `ADD CONSTRAINT` on **every run, forever** — so a
 * push-synced database takes ACCESS EXCLUSIVE on that table and spends a
 * window with no FK enforcement each time. `tm_test` is push-synced here and
 * parallel agents re-push it mid-run (CLAUDE.md), so the cost lands on the
 * suite rather than on production, which is exactly the kind of slow bleed
 * nobody traces back to a migration that "worked".
 *
 * Secondary: a runtime FK violation then reports a constraint name that
 * appears nowhere in the codebase, so grepping for it finds nothing.
 *
 * #723's table (`meeting_candidate_disqualifications`, 35 chars) produced the
 * first three over-length identifiers in the repo's history — drizzle derives
 * `<table>_<column>_<reftable>_<refcolumn>_fk`, which reached 69, 67 and 75.
 * The fix there was to name the FKs explicitly with a short prefix; this test
 * is what makes the next long table name fail in CI instead of in a NOTICE.
 *
 * BYTES, not characters: Postgres' `NAMEDATALEN - 1` bound is 63 BYTES, and an
 * identifier may legally be non-ASCII, where one character can cost up to four.
 * `Buffer.byteLength` is the honest measure; `.length` would pass a name
 * Postgres truncates.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Postgres' `NAMEDATALEN - 1`. Not configurable without recompiling. */
const MAX_IDENTIFIER_BYTES = 63;

const DIR = "drizzle";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));

/**
 * Every double-quoted identifier in the file, with its line.
 *
 * Quoted-only is deliberate and is the whole reason this can be a regex rather
 * than a parser: drizzle quotes every identifier it emits, so an unquoted token
 * is SQL syntax (`CREATE`, `TABLE`, `btree`) and never a name that could
 * truncate. Doubled quotes inside an identifier are not something drizzle
 * generates, and a false negative there would only under-report.
 */
function quotedIdentifiers(sql: string): { name: string; line: number }[] {
	const out: { name: string; line: number }[] = [];
	sql.split("\n").forEach((text, i) => {
		for (const m of text.matchAll(/"([^"]+)"/g)) {
			out.push({ name: m[1], line: i + 1 });
		}
	});
	return out;
}

describe("committed migrations carry no over-length identifier (#723)", () => {
	// The vacuity floor. An empty `drizzle/` — a bad path, a rename, a glob that
	// stopped matching — would make every assertion below pass by finding
	// nothing, which is the shape `CODING_STANDARDS.md` records for a guard that
	// counts something. 75 files existed when this was written.
	it("finds the migration files at all", () => {
		expect(files.length).toBeGreaterThan(50);
	});

	it("extracts identifiers from them", () => {
		const total = files.reduce(
			(n, f) =>
				n + quotedIdentifiers(readFileSync(`${DIR}/${f}`, "utf8")).length,
			0,
		);
		expect(total).toBeGreaterThan(1000);
	});

	it("every quoted identifier fits in 63 bytes", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const sql = readFileSync(`${DIR}/${file}`, "utf8");
			for (const { name, line } of quotedIdentifiers(sql)) {
				const bytes = Buffer.byteLength(name, "utf8");
				if (bytes > MAX_IDENTIFIER_BYTES) {
					offenders.push(`${file}:${line} (${bytes} bytes) ${name}`);
				}
			}
		}
		// "Offenders must be EMPTY" shape — it can only fail truthfully, and the
		// message names the file, the line and the byte count so the fix (name the
		// constraint explicitly in `schema.ts`, then regenerate) is one step.
		expect(offenders).toEqual([]);
	});
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * Two guards over the planned-attendance store, both of the "offender list must
 * be EMPTY" shape. That shape is the safe direction for a source grep: a file
 * merely NAMING a dropped table can only make it falsely FAIL, never falsely
 * pass — see `src/test/guard-source.ts`.
 *
 * Guard 1 pins the DROP: `member_availability` and `meeting_outreach` are gone
 * from the database, so a reference to either is dead code or a query that will
 * fail at runtime. Neither typecheck nor any test can see the difference once
 * the reference is inside a raw `sql` template, because the table name there is
 * just a string.
 *
 * Guard 2 pins the SEAM: `meeting_attendance_plan` is reached only through
 * `attendance-plan-logic.ts`, so the actor attribution and the status predicates
 * that stop one rung overwriting another (`demoteFrom` / `onlyFrom`) live in
 * exactly one place. An inline query elsewhere would bypass both and still
 * typecheck.
 *
 * It does NOT put the archive gate or the officer-only `reached_out` rung there
 * — both need a session, so they belong to the callers. An earlier version of
 * this comment claimed all three, which is worth more than a pedantic
 * correction: that sentence is exactly what would persuade the next author that
 * a new writer inherits an authorization check it never got.
 *
 * ## Why the two guards have DIFFERENT scopes
 *
 * They are not symmetric, and the asymmetry is deliberate.
 *
 * Guard 1 covers TEST files as well as source, reading the test files
 * comment-blind. Reading comment-blind LOOSENS an offender-list guard, which is
 * normally the wrong direction — but the whole residual risk here is inert
 * commented-out text, while the risk it closes is live: a raw-SQL reference to
 * a dropped table inside a `describe.skipIf(!hasTestDb)` suite is invisible to
 * a local run with no database AND to typecheck. `roster-mgmt.integration.test.ts`
 * is the worked example — it seeded `member_availability` rows as merge fixture
 * setup, and an earlier src-only version of this guard did not see it. Reading
 * raw instead is not an option: four surviving test files describe the dropped
 * tables in prose, correctly, as history.
 *
 * Guard 2 stays source-only. Extending it to tests names nine integration
 * suites that legitimately seed plan rows as fixtures — a waiver list that
 * would grow with every new integration test, which is the shape of a guard
 * that gets deleted rather than maintained.
 *
 * Both sweep `scripts/` as well as `src/`: it holds db-touching modules,
 * including production backfills, which are exactly the file shape that names a
 * table in raw SQL.
 */

/** Repo root, so the walk does not depend on the process cwd. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SEAM = "src/server/attendance-plan-logic.ts";

/** This file names every string below in its own literals. */
const SELF = "src/server/attendance-plan-store.guard.test.ts";

/**
 * The ONE file allowed to name the dropped tables in live code.
 *
 * It executes `drizzle/0061_backfill_attendance_plan.sql` against real rows, so
 * it has to recreate the two tables the backfill reads FROM — they are gone from
 * `schema.ts`, which is the whole point, so there is no fixture that can make
 * them. Waiving it is strictly better than the alternative it replaces: without
 * that test the backfill is exercised only against an empty database (CI
 * migrates from scratch; `tm_test` is push-synced and skips migrations), where
 * both INSERTs copy zero rows and pass vacuously, while `0062` drops the sources
 * in the same transaction so a wrong precedence is unrecoverable.
 *
 * Narrow on purpose: one path, not a directory or a pattern. The names are dead
 * everywhere else, and this waiver does not make them less dead — that file
 * CREATES the tables it names and drops them again in `afterEach`.
 */
const BACKFILL_TEST = "src/server/attendance-plan-backfill.integration.test.ts";

/**
 * Both the SQL identifier and the drizzle export for each dropped table. The
 * pair matters: a raw `sql` template names the table in snake_case, a drizzle
 * query names the exported symbol, and the two are separate ways to reach the
 * same gone table.
 */
const DROPPED = [
	"member_availability",
	"memberAvailability",
	"meeting_outreach",
	"meetingOutreach",
];

/** Same pairing, for the table that is still very much alive. */
const PLAN = ["meeting_attendance_plan", "meetingAttendancePlan"];

/** Every `.ts`/`.tsx` under `dir`, tests included, as repo-relative paths. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
	for (const name of readdirSync(join(ROOT, dir))) {
		const path = `${dir}/${name}`;
		if (statSync(join(ROOT, path)).isDirectory()) sourceFiles(path, acc);
		else if (/\.tsx?$/.test(name)) acc.push(path);
	}
	return acc;
}

const FILES = [...sourceFiles("src"), ...sourceFiles("scripts")];
const isTest = (f: string) => /\.test\.tsx?$/.test(f);
const abs = (f: string) => join(ROOT, f.split("/").join(sep));

describe("planned-attendance store", () => {
	it("names no dropped table anywhere in src/ or scripts/", () => {
		const offenders = FILES.filter((f) => {
			if (f === SELF || f === BACKFILL_TEST) return false;
			// Source RAW (the safe direction); tests comment-blind, so their prose
			// history of the dropped tables stays legal. See the header.
			const src = isTest(f) ? readSource(abs(f)) : readFileSync(abs(f), "utf8");
			return DROPPED.some((t) => src.includes(t));
		});
		expect(
			offenders,
			"`member_availability` and `meeting_outreach` were DROPPED from the database. " +
				"A reference to either is dead code or a query that fails at runtime; " +
				"use `meeting_attendance_plan` via `attendance-plan-logic.ts` instead. " +
				"(In a test file this fires on live code only — prose about the old tables is fine.)",
		).toEqual([]);
	});

	// A waiver keyed on a path rots in one direction silently. RENAMING the file
	// re-offends and fails loudly, which is fine — but DELETING it leaves a
	// waiver for nothing, and the next reader sees an exemption implying the
	// backfill is covered when it no longer is. Deleting the test must therefore
	// fail here too, forcing the waiver out at the same time.
	it("still waives a file that exists, and it still earns the waiver", () => {
		expect(
			FILES,
			`${BACKFILL_TEST} is waived from the dropped-table guard, but no such ` +
				"file exists. Either restore it or drop the waiver — an exemption " +
				"for a deleted test reads as coverage that is not there.",
		).toContain(BACKFILL_TEST);
		// And it is waived because it EXECUTES the migration, not merely because it
		// mentions the old names. If that stops being true the waiver is too wide.
		expect(readFileSync(abs(BACKFILL_TEST), "utf8")).toContain(
			"0061_backfill_attendance_plan.sql",
		);
	});

	it("is reached only through the seam", () => {
		const offenders = FILES.filter((f) => {
			// Tests seed plan rows as fixtures — see the header for why they are out
			// of scope here but IN scope for the guard above.
			if (isTest(f)) return false;
			if (f === SEAM || f.endsWith("schema.ts")) return false;
			// The membership merge de-dups with raw SQL before re-pointing; that
			// two-statement dance has no seam function and does not want one.
			if (f.endsWith("membership-collapse-logic.ts")) return false;
			// BOTH spellings: matching only the drizzle symbol would wave through
			// `tx.execute(sql`… meeting_attendance_plan …`)`, which is precisely the
			// bypass shape the waiver above exists to permit, and precisely the one
			// typecheck cannot see.
			const src = readFileSync(abs(f), "utf8");
			return PLAN.some((t) => src.includes(t));
		});
		expect(
			offenders,
			"`meeting_attendance_plan` is reached only through the seam. Use " +
				"`getPlanStatus` / `listPlanForMeetings` / `listNotComingWithNames` / " +
				"`listNotComingForMeetings` / `listReachedOutForMeeting` / " +
				"`listComingForMeeting` / `setPlanStatus` / " +
				`\`clearPlanStatus\`, or add a new function to ${SEAM} — an inline query ` +
				"bypasses the actor attribution and the `demoteFrom` / `onlyFrom` " +
				"predicates that stop one rung overwriting another.",
		).toEqual([]);
	});
});

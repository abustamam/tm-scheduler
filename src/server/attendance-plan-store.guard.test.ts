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
 * `attendance-plan-logic.ts`, so the archive gate, the officer-only
 * `reached_out` rung and the actor attribution live in exactly one place. An
 * inline query elsewhere would bypass all three and still typecheck.
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
			if (f === SELF) return false;
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
				"`listNotComingForMeetings` / `listReachedOutForMeeting` / `setPlanStatus` / " +
				`\`clearPlanStatus\`, or add a new function to ${SEAM} — an inline query ` +
				"bypasses the archive gate and the officer-only `reached_out` rung.",
		).toEqual([]);
	});
});

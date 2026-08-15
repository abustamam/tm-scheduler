import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Two directional guards, both reading source RAW (deliberately NOT via
 * `#/test/guard-source`, which blanks comments): each asserts a set of
 * offenders is EMPTY, so a comment merely NAMING a dropped table can only make
 * them falsely FAIL, never falsely pass. Blanking comments would LOOSEN them.
 * That is the opposite direction from the "this pattern must BE present"
 * guards — see `src/test/guard-source.ts` for why the direction matters.
 *
 * Guard 1 pins the DROP: `member_availability` and `meeting_outreach` are gone
 * from the database as of this PR, so a source file naming either one is
 * either dead code or a query that will fail at runtime — neither typecheck
 * nor any test can see the difference, because a raw `sql` string is opaque to
 * both.
 *
 * Guard 2 pins the SEAM: `meeting_attendance_plan` is reached only through
 * `attendance-plan-logic.ts`, so the archive gate, the officer-only
 * `reached_out` rung and the actor attribution live in exactly one place. An
 * inline query elsewhere would bypass all three and still typecheck.
 */

/** Repo root, so the walk does not depend on the process cwd. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SEAM = "src/server/attendance-plan-logic.ts";

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

/** Every non-test `.ts`/`.tsx` under `src/`, as repo-relative paths. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
	for (const name of readdirSync(join(ROOT, dir))) {
		const path = `${dir}/${name}`;
		if (statSync(join(ROOT, path)).isDirectory()) sourceFiles(path, acc);
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
			acc.push(path);
	}
	return acc;
}

const FILES = sourceFiles("src");
const read = (path: string) =>
	readFileSync(join(ROOT, path.split("/").join(sep)), "utf8");

describe("planned-attendance store", () => {
	it("names no dropped table anywhere in src/", () => {
		const offenders = FILES.filter((f) => {
			const src = read(f);
			return DROPPED.some((t) => src.includes(t));
		});
		expect(
			offenders,
			"`member_availability` and `meeting_outreach` were DROPPED from the database. " +
				"A reference to either is dead code or a query that fails at runtime; " +
				"use `meeting_attendance_plan` via `attendance-plan-logic.ts` instead.",
		).toEqual([]);
	});

	it("is reached only through the seam", () => {
		const offenders = FILES.filter((f) => {
			if (f === SEAM || f.endsWith("schema.ts")) return false;
			// The membership merge de-dups with raw SQL before re-pointing; that
			// two-statement dance has no seam function and does not want one.
			if (f.endsWith("membership-collapse-logic.ts")) return false;
			return read(f).includes("meetingAttendancePlan");
		});
		expect(
			offenders,
			"`meeting_attendance_plan` is reached only through the seam. Use " +
				"`listPlanForMeetings` / `listNotComingWithNames` / `listNotComingForMeetings` / " +
				"`listReachedOutForMeeting` / `setPlanStatus` / `clearPlanStatus`, or add a new " +
				`function to ${SEAM} — an inline query bypasses the archive gate and the ` +
				"officer-only `reached_out` rung.",
		).toEqual([]);
	});
});

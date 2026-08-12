import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * The rung each legacy delegate writes (D6, 2026-08-11).
 *
 * `availability.ts` and `outreach.ts` keep their exported names through PR 1 and
 * now delegate onto the `meeting_attendance_plan` seam, so the ONE thing each
 * carries is which rung of the ladder it means. Nothing else can see that
 * choice: a `createServerFn` handler cannot be invoked in vitest, so
 * `availability.integration.test.ts` and `outreach.integration.test.ts`
 * REPRODUCE the handler bodies rather than calling them — the props-are-the-
 * fixture blind spot of #319, one layer down.
 *
 * That is not hypothetical here. Mutating `setContacted` to write `coming` AND
 * `setAvailability` to write `coming` at the same time left the entire suite at
 * its usual pass count. Both `clear*` delegates are unpinned by the same
 * construction, so all four are enrolled below rather than the one that was
 * measured.
 *
 * Consequences of a wrong rung, so the failure message is worth reading: a
 * decline recorded as `coming` leaves the member on the roles the season grid
 * offers them, and a `reached_out` recorded as `coming` tells the VPE someone
 * has confirmed when all that happened is that they were asked.
 *
 * TWO readers, one per assertion class (`src/test/guard-source.ts`): "must call
 * X" is comment-blind, because these modules discuss their own delegation in
 * prose and a raw read would keep passing after the real call was deleted;
 * "must NOT call Y" is verbatim, because stripping only deletes text and could
 * erase a real offending call.
 *
 * Dies with the delegates: PR 2 repoints the panel at `setPlannedAttendance`
 * and deletes both modules, and this file goes with them.
 *
 * `markUnavailableReleasing` is deliberately absent — its rung lives in
 * `releaseSlotsAndMarkUnavailable`, which IS directly callable and IS pinned
 * behaviourally by availability.integration.test.ts (verified by mutation).
 */
const SERVER_DIR = __dirname;

/** One `export const <name> = createServerFn…` declaration, so a per-handler
 *  assertion cannot be satisfied by its neighbour's correct code. */
function handlerBody(source: string, name: string, file: string): string {
	const start = source.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found in ${file} — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = source.indexOf("\nexport const", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

interface Delegate {
	file: string;
	fn: string;
	/** The exact rung it must write, or null for the clearing pair. */
	rung: string | null;
	/** What a wrong rung would do to the product. */
	breaks: string;
}

const DELEGATES: Delegate[] = [
	{
		file: "availability.ts",
		fn: "setAvailability",
		rung: "not_coming",
		breaks:
			"a member who declined would still be counted as available, and the season grid would keep offering them roles",
	},
	{
		file: "outreach.ts",
		fn: "setContacted",
		rung: "reached_out",
		breaks:
			"being ASKED would be recorded as having CONFIRMED, so the VPE's outreach list would show an answer nobody gave",
	},
	{
		file: "availability.ts",
		fn: "clearAvailability",
		rung: null,
		breaks: "clearing an answer would instead write one",
	},
	{
		file: "outreach.ts",
		fn: "clearContacted",
		rung: null,
		breaks: "clearing an answer would instead write one",
	},
];

describe("legacy delegates write the rung they are named for (D6)", () => {
	for (const d of DELEGATES) {
		const path = resolve(SERVER_DIR, d.file);
		/** Comment-blind — for "must be present" only. */
		const stripped = readSource(path);
		/** Verbatim — for "must be absent" only. */
		const raw = readFileSync(path, "utf8");

		if (d.rung) {
			it(`${d.fn} writes status: "${d.rung}"`, () => {
				expect(
					handlerBody(stripped, d.fn, d.file),
					`${d.fn} must hand the seam status: "${d.rung}" — with any other rung ${d.breaks}. Its own integration suite reproduces this body rather than calling it, so nothing else can see the change.`,
				).toContain(`status: "${d.rung}"`);
			});
		} else {
			it(`${d.fn} clears the row rather than setting a rung`, () => {
				expect(
					handlerBody(stripped, d.fn, d.file),
					`${d.fn} must call clearPlanStatus — ${d.breaks}.`,
				).toContain("clearPlanStatus(");
			});

			it(`${d.fn} never calls setPlanStatus`, () => {
				expect(
					handlerBody(raw, d.fn, d.file),
					`${d.fn} must not call setPlanStatus — ${d.breaks}.`,
				).not.toContain("setPlanStatus(");
			});
		}
	}
});

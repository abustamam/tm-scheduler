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
 * `markUnavailableReleasing` is absent from the RUNG table — its rung lives in
 * `releaseSlotsAndMarkUnavailable`, which IS directly callable and IS pinned
 * behaviourally by availability.integration.test.ts (verified by mutation). It
 * is still enrolled for the archive gate at the bottom of this file, because
 * that check belongs to the handler rather than the seam and it is the third
 * public session-less writer in `availability.ts`.
 *
 * Beyond the rung, each delegate is pinned for the STATUS PREDICATE it hands the
 * seam. That is a separate failure from a wrong rung and a worse one: the seam's
 * own tests prove `demoteFrom` / `onlyFrom` work, and only these assertions
 * prove the caller passes them. Dropping one argument from `clearAvailability`
 * leaves every seam test green while restoring an anonymous caller's ability to
 * delete an officer's `reached_out` — which is where this PR's authorization
 * regression actually lived.
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
	/**
	 * The status predicate this delegate must hand the seam, verbatim, or null if
	 * it is deliberately unrestricted.
	 *
	 * Pinned HERE and not only in the seam's own tests, because those prove the
	 * predicate WORKS and this proves the delegate USES it — the gap between the
	 * two is precisely where the authorization regression lived. Deleting the
	 * argument leaves `clearPlanStatus` correct, its unit tests green, and an
	 * anonymous caller able to erase an officer's `reached_out` again.
	 */
	predicate: string | null;
	/** Why that predicate is what it is, for whoever reads the failure. */
	predicateBreaks: string;
}

const DELEGATES: Delegate[] = [
	{
		file: "availability.ts",
		fn: "setAvailability",
		rung: "not_coming",
		breaks:
			"a member who declined would still be counted as available, and the season grid would keep offering them roles",
		// Unrestricted ON PURPOSE, and the opposite of the others: writing
		// `not_coming` over an officer's `reached_out` is the ladder working — they
		// asked, the member answered. A predicate here would DISCARD the answer.
		predicate: null,
		predicateBreaks:
			"restricting this would silently drop a member's own decline whenever an officer had already asked them",
	},
	{
		file: "outreach.ts",
		fn: "setContacted",
		rung: "reached_out",
		breaks:
			"being ASKED would be recorded as having CONFIRMED, so the VPE's outreach list would show an answer nobody gave",
		predicate: 'demoteFrom: ["reached_out"]',
		predicateBreaks:
			"without it, ticking a stale 'contacted' checkbox overwrites a decline that arrived since — the member then drops off the meeting page's Not Available list AND loses the assign picker's warning, so the VPE hands a role to someone who said they cannot come",
	},
	{
		file: "availability.ts",
		fn: "clearAvailability",
		rung: null,
		breaks: "clearing an answer would instead write one",
		predicate: "onlyFrom: SELF_SERVICE_RUNGS",
		predicateBreaks:
			"this endpoint takes NO session, and without the predicate it deletes whatever rung is there — including an officer's `reached_out`, which before the consolidation took requireUser() + requireClubRole(admin) to remove",
	},
	{
		file: "outreach.ts",
		fn: "clearContacted",
		rung: null,
		breaks: "clearing an answer would instead write one",
		predicate: 'onlyFrom: ["reached_out"]',
		predicateBreaks:
			"unticking 'contacted' must remove the ask and nothing else; without it an officer's untick also wipes a `coming` or `not_coming` the MEMBER put there",
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

		if (d.file === "availability.ts") {
			it(`${d.fn} gates on the club's archived_at`, () => {
				// These three are the session-less writers, so `requireMembership`'s
				// archive check (#186) never runs for them and they have to do it
				// themselves — the reason `assertClubNotArchived` is exported at all.
				// `outreach.ts` is excluded because `requireClubRole` already covers it.
				expect(
					handlerBody(stripped, d.fn, d.file),
					`${d.fn} is PUBLIC and takes no session, so archiving — the platform takedown lever — does not otherwise reach it (#555).`,
				).toContain("assertClubNotArchived(meeting.clubId)");
			});
		}

		if (d.predicate) {
			it(`${d.fn} hands the seam \`${d.predicate}\``, () => {
				expect(
					handlerBody(stripped, d.fn, d.file),
					`${d.fn} must pass ${d.predicate} — ${d.predicateBreaks}. The seam's own tests prove the predicate works; only this one proves this caller uses it.`,
				).toContain(d.predicate);
			});
		} else {
			it(`${d.fn} stays unrestricted on purpose`, () => {
				// A negative, so read VERBATIM: the prose above explains why this
				// delegate must NOT carry a predicate, and a comment-blind read would
				// let the explanation satisfy the assertion it is explaining.
				const body = handlerBody(raw, d.fn, d.file);
				expect(
					body,
					`${d.fn} must NOT restrict the write — ${d.predicateBreaks}.`,
				).not.toContain("demoteFrom:");
				expect(body).not.toContain("onlyFrom:");
			});
		}
	}

	// Enrolled for the archive gate ONLY. It is excluded from `DELEGATES` above
	// because its rung lives in `releaseSlotsAndMarkUnavailable` and is pinned
	// behaviourally there — but it is the third PUBLIC, session-less writer in
	// this file, so it needs the takedown check exactly as much as the other two,
	// and being absent from the table is how it would be forgotten.
	it("markUnavailableReleasing gates on the club's archived_at", () => {
		const path = resolve(SERVER_DIR, "availability.ts");
		expect(
			handlerBody(
				readSource(path),
				"markUnavailableReleasing",
				"availability.ts",
			),
			"markUnavailableReleasing is PUBLIC and takes no session, so archiving does not otherwise reach it (#555).",
		).toContain("assertClubNotArchived(meeting.clubId)");
	});
});

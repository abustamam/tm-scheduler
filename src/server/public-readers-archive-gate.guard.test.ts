/**
 * Wiring guard for the public archive gate (#544).
 *
 * `public-readers-archive-gate.integration.test.ts` proves each gated SEAM
 * refuses an archived club. It cannot prove the `createServerFn` handlers
 * actually CALL those seams — a handler body needs the Start runtime, so no
 * test in this repo can execute one. That is the same blind spot #319 shipped
 * through: `VisitCta` and `AboutClub` were both well covered and the bug was in
 * neither, because the defect was the expression at the CALL SITE.
 *
 * Here the gap is unusually easy to fall into, because the safe and the unsafe
 * function are INTERCHANGEABLE:
 *
 *     resolveMeetingKey(clubId, key)        // no archive check
 *     resolvePublicMeetingKey(clubId, key)  // archive-gated
 *
 * Identical signatures, identical return type. Swapping one for the other
 * typechecks, passes lint, and leaves all 14 integration cases green — they
 * exercise the seam directly and never touch the handler. The same holds for
 * `listRoleDefinitions` vs `loadPublicClubRoles` and for the two extractions
 * this change made (`loadPublicClubRoster`, `loadUpcomingMeetings`), whose
 * whole point was to move a query somewhere a test can reach.
 *
 * So this guard pins the wiring: every PUBLIC server fn below must call its
 * gated seam, and must not call the ungated sibling.
 *
 * READ MODE — TWO readers, one per assertion class. This file holds both, and
 * `src/test/guard-source.ts` says each class needs the opposite reader:
 *
 *   · "must CALL x" (positive) → `readStripped`. A comment naming the function
 *     satisfies a raw `toContain`, so a handler could be rewired to the ungated
 *     call while a comment above it still said `loadPublicClubRoster` and a raw
 *     read would report clean. Comment-blind closes that false PASS.
 *   · "must NOT call y" (negative) → `readRaw`. Stripping only DELETES text, and
 *     the stripper is a lexer, not a parser: it does not track string/template
 *     literals, so a `//` inside one blanks the rest of that line and could
 *     erase a real offending call from the text being searched. That is a false
 *     PASS on the half that exists to catch the regression.
 *
 * Blanket-applying either reader is the bypass #502 shipped twice in one branch,
 * in both directions. Verified here by mutating one assertion of EACH class (a
 * rewire to `resolveMeetingKey` for the negative, a deleted call for the
 * positive) and confirming each fails.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");

/** Comment-blind — for "the call must BE present" assertions only. */
const readStripped = (abs: string) => readSource(abs);
/** Verbatim — for "the offending call must be ABSENT" assertions only. */
const readRaw = (abs: string) => readFileSync(abs, "utf8");

/**
 * The body of one `export const <name> = createServerFn…` declaration, sliced
 * from its call site to the next top-level `export` (or EOF).
 *
 * Statement-scoped rather than whole-file on purpose: `meetings.ts` holds both
 * the public key readers AND authed fns that legitimately call the ungated
 * `resolveMeetingKey`, so a whole-file "must not contain" assertion would be
 * unsatisfiable and a whole-file "must contain" one would be satisfied by a
 * DIFFERENT function's correct call.
 */
function serverFnBody(source: string, name: string): string {
	const start = source.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = source.indexOf("\nexport ", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

interface Wiring {
	/** Server-fn module, relative to `src/`. */
	file: string;
	/** The PUBLIC (no-session) server fn. */
	fn: string;
	/** The archive-gated seam it must route through. */
	mustCall: string;
	/** The ungated sibling it must NOT call. Omitted where none exists. */
	mustNotCall?: string;
	/** Why this endpoint is worth gating — shown when the case fails. */
	leaks: string;
}

const WIRINGS: Wiring[] = [
	{
		file: "server/role-definitions.ts",
		fn: "getPublicClubRoles",
		mustCall: "loadPublicClubRoles",
		mustNotCall: "listRoleDefinitions",
		leaks: "the club's role template",
	},
	{
		file: "server/clubs.ts",
		fn: "getPublicClubProfileFn",
		mustCall: "getPublicClubProfile",
		mustNotCall: "getClubProfile(",
		leaks: "club-authored mission text (the ADR-0024 takedown field)",
	},
	{
		file: "server/season-grid.ts",
		fn: "getPublicSeasonGrid",
		mustCall: "loadPublicSeasonGrid",
		mustNotCall: "loadSeasonGrid(",
		leaks: "roster names on the member axis",
	},
	{
		file: "server/members.ts",
		fn: "listMembers",
		mustCall: "loadPublicClubRoster",
		leaks: "the full active roster",
	},
	{
		file: "server/meetings.ts",
		fn: "listUpcomingMeetings",
		mustCall: "loadUpcomingMeetings",
		leaks: "the club's forward schedule",
	},
	{
		file: "server/meetings.ts",
		fn: "listPastMeetings",
		mustCall: "loadPastMeetings",
		leaks: "the club's meeting history",
	},
	{
		file: "server/meetings.ts",
		fn: "getPublicMeetingByKey",
		mustCall: "resolvePublicMeetingKey",
		mustNotCall: "resolveMeetingKey(",
		leaks: "a full agenda: assignee names, speech titles, Word of the Day",
	},
	{
		// Takes a session but does not REQUIRE one, so it is just as reachable
		// anonymously as the fn above and needs the same resolver.
		file: "server/meetings.ts",
		fn: "getMeetingByKey",
		mustCall: "resolvePublicMeetingKey",
		mustNotCall: "resolveMeetingKey(",
		leaks: "a full agenda: assignee names, speech titles, Word of the Day",
	},
	{
		file: "server/voting.ts",
		fn: "getBallot",
		mustCall: "loadBallot",
		leaks: "ballot candidate names (members and guests)",
	},
];

describe("public server fns are wired to their archive-gated seam (#544)", () => {
	for (const w of WIRINGS) {
		it(`${w.fn} routes through ${w.mustCall}`, () => {
			const abs = resolve(ROOT, "src", w.file);

			// Positive: comment-blind, so a comment naming the seam can't fake it.
			expect(
				serverFnBody(readStripped(abs), w.fn),
				`${w.fn} must call ${w.mustCall} — without it an ARCHIVED club still serves ${w.leaks}. Archiving is the takedown lever (ADR-0016 / ADR-0024).`,
			).toContain(w.mustCall);

			if (w.mustNotCall) {
				// Negative: verbatim, so a stripper artifact can't erase a real call.
				expect(
					serverFnBody(readRaw(abs), w.fn),
					`${w.fn} must not call ${w.mustNotCall} — it carries no archive check. Use ${w.mustCall}. The two have the same signature, so nothing else in the suite can tell them apart.`,
				).not.toContain(w.mustNotCall);
			}
		});
	}
});

describe("the gate module stays the one home for the check (#544)", () => {
	/**
	 * `isReadableClub` lived in `club-logo-logic.ts` before #544, which is a
	 * large part of why two later public readers were written without it: nobody
	 * adding a club-profile endpoint goes looking inside a LOGO module for the
	 * club-wide archive check. It now lives in `club-readable-logic.ts`. If it drifts
	 * back into a feature module, the next reader will miss it the same way.
	 */
	it("defines isReadableClub in club-readable-logic.ts and nowhere else", () => {
		// Positive → stripped; negative → raw. Same split as above.
		const home = readStripped(
			resolve(ROOT, "src/server/club-readable-logic.ts"),
		);
		expect(home).toContain("export async function isReadableClub(");
		expect(home).toContain("export async function isReadableClubForMeeting(");

		const logo = readRaw(resolve(ROOT, "src/server/club-logo-logic.ts"));
		expect(
			logo,
			"isReadableClub moved to club-readable-logic.ts (#544) so public readers can find it. Import it there rather than redefining it here.",
		).not.toContain("export async function isReadableClub");
	});
});

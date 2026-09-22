/**
 * Every MUTATING vote server fn must be gated (#510).
 *
 * Reads the source rather than the module: a "must be present" guard is
 * satisfied by a comment that merely names the pattern, so it reads the real
 * text and strips comments before asserting.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource("src/server/voting.ts");

const GATED = [
	"openVoteFn",
	"closeVoteFn",
	// #723 — a new write that decides who may exclude another person from an
	// award. Gated exactly as open/close are, and enrolled here in the same
	// change: a gate nothing asserts is one refactor from being dropped.
	"disqualifyCandidateFn",
	"undoDisqualificationFn",
	"getVoteTally",
];

/**
 * The two that additionally require a SESSION (#752), and the three that
 * deliberately do NOT.
 *
 * Both halves are asserted, and the second is the one a sweep cannot state.
 * #752 cuts INSIDE the Ballot Counter arm: ruling a candidate out publishes free
 * text about a named third party and leaves an activity-log entry the undo
 * cannot remove, so it needs a session — while open, close and the tally stay
 * reachable by the account-less Ballot Counter, because that is the workflow
 * ADR-0010 was written for and #510 handed them. Without the NOT half, "require
 * a session everywhere in this file" reads as strictly safer and would silently
 * take the whole console away from a Ballot Counter with no account, mid-meeting
 * — the exact regression #752 names as the one this change could ship.
 *
 * The two gate names are disjoint as SUBSTRINGS, which is what lets one grep
 * separate them: `requireSignedInVoteCounter(` does not contain
 * `requireVoteCounter(`. Both directions are asserted per export below, so a
 * swap in either direction fails rather than half-matching.
 */
const SESSION_GATE = "requireSignedInVoteCounter(";
const ANON_GATE = "requireVoteCounter(";
const SESSION_GATED = ["disqualifyCandidateFn", "undoDisqualificationFn"];
const ANON_GATED = GATED.filter((n) => !SESSION_GATED.includes(n));

/**
 * The slice of SOURCE covering just `name`'s export — from its `export const`
 * line up to whichever other GATED export comes next, or EOF. Bounding to the
 * NEXT export (rather than a fixed-length window) matters: mutation-testing
 * this guard found that a fixed offset here bled into the following export's
 * body and matched ITS call instead of noticing the removal from `name`'s own
 * body — a false pass. Bounding to EOF for the last-declared export is also
 * why `requireVoteCounter` is declared BEFORE these exports in voting.ts: were
 * it declared after (as after `getVoteTally`, the last export), its own
 * `async function requireVoteCounter(...` declaration text would fall inside
 * that final slice and satisfy the assertion even with the real call removed.
 */
function gatedExportBody(name: string): string {
	const start = SOURCE.indexOf(`export const ${name} =`);
	expect(start, `${name} not found`).toBeGreaterThan(-1);
	const next = GATED.map((n) =>
		n === name ? -1 : SOURCE.indexOf(`export const ${n} =`),
	)
		.concat(SOURCE.length)
		.filter((i) => i > start)
		.sort((a, b) => a - b)[0];
	return SOURCE.slice(start, next);
}

describe("voting server fns are gated (#510)", () => {
	for (const name of ANON_GATED) {
		it(`${name} calls requireVoteCounter`, () => {
			expect(gatedExportBody(name)).toContain(ANON_GATE);
		});

		// The NOT half of #752 (see SESSION_GATED): these three must stay
		// reachable with no session at all.
		it(`${name} does NOT require a session`, () => {
			expect(gatedExportBody(name)).not.toContain(SESSION_GATE);
		});
	}

	for (const name of SESSION_GATED) {
		it(`${name} calls requireSignedInVoteCounter (#752)`, () => {
			expect(gatedExportBody(name)).toContain(SESSION_GATE);
		});

		// And does NOT also call the anonymous gate. Not redundant: the refusal
		// has to be unconditional, and a body holding BOTH calls is how a
		// "keep the old path for compatibility" edit would look — the session
		// check would then sit beside a call that already granted.
		it(`${name} does not ALSO call the anonymous gate`, () => {
			expect(gatedExportBody(name)).not.toContain(ANON_GATE);
		});
	}

	// Every LIVE-WINDOW operation, which since #723 is four rather than two.
	// `getVoteTally` is deliberately not among them — the tally must stay
	// readable after the meeting is completed, which is exactly when the winner
	// gets confirmed.
	it("the window operations assert the meeting lock", () => {
		for (const name of [
			"openVoteFn",
			"closeVoteFn",
			"disqualifyCandidateFn",
			"undoDisqualificationFn",
		]) {
			expect(gatedExportBody(name)).toContain("assertMeetingNotLocked(");
		}
	});

	// The inverse, and the half a "must be present" sweep cannot state: the one
	// GATED export that must NOT assert the lock. Without this, "add the lock
	// everywhere" reads as strictly safer and would silently break confirming a
	// winner on a completed meeting — the normal case, since completion is when
	// the minutes get written.
	it("getVoteTally does NOT assert the meeting lock", () => {
		expect(gatedExportBody("getVoteTally")).not.toContain(
			"assertMeetingNotLocked(",
		);
	});
});

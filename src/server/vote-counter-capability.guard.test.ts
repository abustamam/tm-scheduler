// Which capability each of the ten vote-console server fns calls (#1472 AC 9).
//
// The Toastmaster joined `requireVoteCounterCapability`, so that ONE function
// now decides the eight reads and writes below, and the two ruling fns must
// stay on the stricter `requireSignedInVoteCounter`, which refuses the
// Toastmaster. Each assertion is anchored INSIDE the named export's own body
// (`serverFnBody`), comment-blind, so a mention elsewhere in the file cannot
// satisfy it. `voting-authz.guard.test.ts` and `minutes-authz.guard.test.ts`
// pin the same gates per file with their own bounds; this file adds the one
// link they leave open (the local `requireVoteCounter` wrapper delegates) and
// states the whole AC 9 list in one place.
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const VOTING = readSource("src/server/voting.ts");
const MINUTES = readSource("src/server/minutes.ts");

/** Body of the module-private `async function requireVoteCounter(...)`. */
function wrapperBody(): string {
	const start = VOTING.indexOf("async function requireVoteCounter(");
	expect(start, "requireVoteCounter wrapper not found").toBeGreaterThan(-1);
	const end = VOTING.indexOf("\n}\n", start);
	return VOTING.slice(start, end);
}

describe("the Toastmaster-capable vote console fns (#1472 AC 9)", () => {
	// protects=the three voting fns reach `requireVoteCounterCapability` (through
	//   voting.ts's local wrapper) and the five minutes fns call it directly, so
	//   the Toastmaster grant applies to all eight (AC 9);
	// fails_when=any one of them swaps to another gate, or the wrapper stops
	//   delegating to the capability;
	// no_claim=the capability's own decision (vote-counter-capability.integration);
	//   the fns are not invoked, since createServerFn needs a request
	for (const name of ["openVoteFn", "closeVoteFn", "getVoteTally"]) {
		it(`${name} calls the wrapper, which delegates to requireVoteCounterCapability`, () => {
			expect(serverFnBody(VOTING, name)).toContain("requireVoteCounter(");
			expect(wrapperBody()).toContain("requireVoteCounterCapability(");
		});
	}

	for (const name of [
		"addTableTopics",
		"removeTableTopics",
		"moveTableTopics",
		"setMinutesAward",
		"clearMinutesAward",
	]) {
		it(`${name} calls requireVoteCounterCapability`, () => {
			expect(serverFnBody(MINUTES, name)).toContain(
				"requireVoteCounterCapability(",
			);
		});
	}

	// protects=ruling a candidate out stays on the gate that refuses the
	//   Toastmaster (AC 9);
	// fails_when=disqualify or undo moves to the wider capability, or drops the
	//   session check;
	// no_claim=the refusal itself (vote-counter-capability.integration.test.ts)
	for (const name of ["disqualifyCandidateFn", "undoDisqualificationFn"]) {
		it(`${name} calls requireSignedInVoteCounter and not the wider gate`, () => {
			const body = serverFnBody(VOTING, name);
			expect(body).toContain("requireSignedInVoteCounter(");
			expect(body).not.toContain("requireVoteCounter(");
			expect(body).not.toContain("requireVoteCounterCapability(");
		});
	}
});

// Route wiring pins for the Toastmaster's access to the vote console (#1472).
//
// The route cannot be rendered in jsdom (loader + server fns), so the
// expressions are asserted against the real source, comment-blind like
// `vote-counter-console-wiring.guard.test.ts`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);

describe("Toastmaster vote console wiring (#1472)", () => {
	const src = readSource(ROUTE);

	// protects=the console renders for the meeting's Toastmaster and not for a
	//   member with no slot and no admin grant (AC 10); fails_when=`isTmod` is
	//   dropped from the render condition, or the condition is widened to
	//   something that admits everyone; no_claim=that `isTmod` is derived right
	//   (deriveMeetingRoleFlags has its own tests); jsdom cannot render the route
	it("renders the console for isVoteCounter (which includes isTmod) or an admin, nothing else", () => {
		expect(src).toContain("const isVoteCounter = isSlotVoteCounter || isTmod;");
		// The one named gate (#1582): the tab's offer and the panel both read it.
		expect(src).toContain(
			"const ballotsShown = (isVoteCounter || effectiveCanManage) && !cancelled;",
		);
		expect(src).toContain("{ballotsShown ? (");
	});

	// protects=the tally poll runs for a Toastmaster, so the console is not empty;
	//   fails_when=the route's isVoteCounter drops isTmod (the hook is handed it);
	// no_claim=the hook's own enabled expression
	it("enables the tally poll for the Toastmaster", () => {
		expect(src).toContain("const isVoteCounter = isSlotVoteCounter || isTmod;");
		// Bounded to the call's own `})`: an unbounded lazy match would reach any
		// later `isVoteCounter,` in the file.
		expect(src).toMatch(
			/useMeetingVotes\(\{[^}]*?\n\t\tisVoteCounter,[^}]*\}\)/,
		);
	});

	// protects=a Toastmaster-only viewer is not shown Disqualify/Undo, which the
	//   server refuses; fails_when=the prop is dropped or widened;
	// no_claim=the server refusal (vote-counter-capability.integration.test.ts)
	it("excludes only a Toastmaster-only viewer from the ruling controls", () => {
		// Whitespace-blind: the console now sits inside a tab panel, so the
		// formatter wraps the prop at a deeper indent (#1582); the prop is unchanged.
		expect(src.replace(/\s+/g, "")).toContain(
			"rulingExcluded={isTmod&&!isSlotVoteCounter&&!canManage}",
		);
	});
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// Structural guard (#529): action items must never reach an anonymous visitor.
//
// They ride inside `MinutesData`, which the canonical meeting route loads ONLY
// behind the `context.shell` gate (a signed-in member of this club) — an
// anonymous visitor gets `EMPTY_MINUTES`, whose `data` is null, so there is no
// action-item payload to leak. This asserts that gate still exists, because the
// leak it prevents is invisible to every other test: the integration suite calls
// the logic directly and the component tests render with data already in hand.
//
// Comment-blind (see `#/test/guard-source`): "the gate must BE present" is
// exactly the assertion shape a prose comment satisfies for free, and this
// route documents its own PII boundary in prose immediately above the fork.
describe("action items stay off every anonymous surface (#529)", () => {
	const meetingRoute = readSource(
		resolve(__dirname, "club.$clubId.meeting.$meetingId.tsx"),
	);

	it("loads minutes only behind the signed-in-member shell gate", () => {
		expect(meetingRoute).toMatch(/context\.shell\s*\n?\s*\?\s*await getMinutes\(/);
	});

	it("hands an anonymous visitor a null minutes payload", () => {
		// EMPTY_MINUTES.data === null is what makes the action-item list
		// unreachable rather than merely unrendered.
		expect(meetingRoute).toMatch(/const EMPTY_MINUTES = \{[\s\S]*?data: null,/);
	});

	// The standalone print/present/word routes are PUBLIC — fully anonymous, no
	// shell. None of them may mention action items at all.
	const PUBLIC_ROUTES = [
		"club.$clubId_.meeting.$meetingId.print.tsx",
		"club.$clubId_.meeting.$meetingId.present.tsx",
		"club.$clubId_.meeting.$meetingId.word.tsx",
		"club.$clubId.index.tsx",
		"club.$clubId_.roles.tsx",
	];

	for (const file of PUBLIC_ROUTES) {
		it(`${file} carries no action-item data`, () => {
			// RAW source on purpose — NOT the comment-stripped `readSource`.
			//
			// These guards split into two classes that comment-stripping moves in
			// OPPOSITE directions. The two assertions above are "the gate must BE
			// present", where a comment naming the gate is a real bypass, so they
			// read stripped. This one is "the offender must be ABSENT", where
			// stripping only LOOSENS the check — it would let a leak hide inside a
			// comment, and worse, a commented-out reference is a sign somebody is
			// mid-way through adding exactly the leak this forbids.
			//
			// Caught by mutation: injecting `// actionItems` into the public print
			// route left this green while it read through `readSource`.
			const src = readFileSync(resolve(__dirname, file), "utf8");
			expect(src).not.toContain("actionItems");
			expect(src).not.toContain("action-items-logic");
			expect(src).not.toContain("ActionItem");
		});
	}
});

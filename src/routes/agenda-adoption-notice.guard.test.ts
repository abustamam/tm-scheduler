import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * Route copy cannot be asserted by mounting: the route needs a router context
 * and a mocked `#/db`. A comment-blind source guard is the reachable gate, and
 * `readSource` blanks comments so the sentence in the JSX above — which quotes
 * the copy — cannot satisfy this on its own.
 */
const ROUTE = "src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx";

describe("adoption notice", () => {
	it("tells the officer that upstream improvements stop arriving", () => {
		// Spec D1/R1 accepted copy-once drift deliberately. That is defensible
		// only while the officer is told at the moment they adopt — 15 of the
		// last 27 commits to the run of show changed beat content, and an
		// adopted club receives none of them.
		const src = readSource(ROUTE);
		expect(src).toMatch(/This agenda is now yours/);
		expect(src).toMatch(/will not reach it/);
	});
});

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

// protects=the checklist server function returning the viewer-aware status (the one that asks the import guard), not the club-only loader;
// fails_when=the handler calls getOnboardingChecklistStatus directly, or passes someone other than the session user;
// no_claim=the guard's answer (onboarding-checklist-logic.integration.test.ts reaches it through the loader).
describe("getOnboardingChecklist wiring (#1498)", () => {
	const body = serverFnBody(
		readSource(join(__dirname, "onboarding-checklist.ts")),
		"getOnboardingChecklist",
	);
	it("returns the viewer-aware status for the session user and the requested club", () => {
		expect(body).toMatch(
			/getOnboardingChecklistStatusForViewer\(\s*currentUser\.id,\s*clubId\s*\)/,
		);
		expect(body).not.toMatch(/getOnboardingChecklistStatus\(/);
	});
});

import { describe, expect, it } from "vitest";
import { isInvitableStage } from "./guest-invite";

describe("isInvitableStage (#899)", () => {
	it("admits the two funnel stages", () => {
		expect(isInvitableStage("prospect")).toBe(true);
		expect(isInvitableStage("following_up")).toBe(true);
	});

	it("refuses joined and lost", () => {
		// A stranded joined row is still stage `joined`; it is refused here and
		// must be moved back to Prospect first.
		expect(isInvitableStage("joined")).toBe(false);
		expect(isInvitableStage("lost")).toBe(false);
	});
});

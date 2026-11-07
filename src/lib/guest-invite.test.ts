import { describe, expect, it } from "vitest";
import { inviteKindFor, isInvitableStage } from "./guest-invite";

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

describe("inviteKindFor", () => {
	it("picks the draft by visits and recency", () => {
		expect(
			inviteKindFor({ visitCount: 0, lastVisitWasLatestMeeting: false }),
		).toBe("never");
		expect(
			inviteKindFor({ visitCount: 1, lastVisitWasLatestMeeting: true }),
		).toBe("firstRecent");
		expect(
			inviteKindFor({ visitCount: 3, lastVisitWasLatestMeeting: true }),
		).toBe("repeatRecent");
		expect(
			inviteKindFor({ visitCount: 1, lastVisitWasLatestMeeting: false }),
		).toBe("lapsed");
		expect(
			inviteKindFor({ visitCount: 3, lastVisitWasLatestMeeting: false }),
		).toBe("lapsed");
	});

	it("treats zero visits as never even if the recency flag is set", () => {
		expect(
			inviteKindFor({ visitCount: 0, lastVisitWasLatestMeeting: true }),
		).toBe("never");
	});
});

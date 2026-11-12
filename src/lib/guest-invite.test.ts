import { describe, expect, it } from "vitest";
import {
	inviteKindFor,
	isInvitableGuest,
	isInvitableStage,
} from "./guest-invite";

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

// protects=the one rule the card and the server share: only a visitor in a
// funnel stage is invitable; fails_when=kind is ignored (a Visiting Toastmaster
// defaults to stage prospect) or the stage is; no_claim=which message is shown.
describe("isInvitableGuest (#1608)", () => {
	const stages = ["prospect", "following_up", "joined", "lost"] as const;
	it.each(stages)("kind x stage: %s", (stage) => {
		expect(isInvitableGuest({ stage, kind: "visitor" })).toBe(
			isInvitableStage(stage),
		);
		expect(isInvitableGuest({ stage, kind: "visiting_toastmaster" })).toBe(
			false,
		);
	});
});

describe("inviteKindFor", () => {
	it("picks the draft by visits and recency", () => {
		expect(
			inviteKindFor({ inviteVisitCount: 0, lastVisitWasLatestMeeting: false }),
		).toBe("never");
		expect(
			inviteKindFor({ inviteVisitCount: 1, lastVisitWasLatestMeeting: true }),
		).toBe("firstRecent");
		expect(
			inviteKindFor({ inviteVisitCount: 3, lastVisitWasLatestMeeting: true }),
		).toBe("repeatRecent");
		expect(
			inviteKindFor({ inviteVisitCount: 1, lastVisitWasLatestMeeting: false }),
		).toBe("lapsed");
		expect(
			inviteKindFor({ inviteVisitCount: 3, lastVisitWasLatestMeeting: false }),
		).toBe("lapsed");
	});

	it("treats zero visits as never even if the recency flag is set", () => {
		expect(
			inviteKindFor({ inviteVisitCount: 0, lastVisitWasLatestMeeting: true }),
		).toBe("never");
	});
});

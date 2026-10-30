import { describe, expect, it } from "vitest";
import { dueMilestones, milestoneKey } from "./milestones";

const M = "member-1";

describe("dueMilestones", () => {
	// protects=both reached milestones come back firstSpeech then tenthMeeting; fails_when=the order follows count or key order; no_claim=what the card shows
	it("returns firstSpeech before tenthMeeting", () => {
		expect(
			dueMilestones(
				M,
				{ speechesDelivered: 3, meetingsAttended: 12 },
				new Set(),
			),
		).toEqual(["firstSpeech", "tenthMeeting"]);
	});

	// protects=a milestone below its threshold is not due; fails_when=9 meetings or 0 speeches count; no_claim=none
	it("is empty below the thresholds", () => {
		expect(
			dueMilestones(
				M,
				{ speechesDelivered: 0, meetingsAttended: 9 },
				new Set(),
			),
		).toEqual([]);
	});

	// protects=seen is per member AND per milestone; fails_when=another member's key or the other milestone hides this one; no_claim=storage
	it("skips only this member's seen milestone", () => {
		const seen = new Set([
			milestoneKey(M, "firstSpeech"),
			milestoneKey("member-2", "tenthMeeting"),
		]);
		expect(
			dueMilestones(M, { speechesDelivered: 1, meetingsAttended: 10 }, seen),
		).toEqual(["tenthMeeting"]);
	});
});

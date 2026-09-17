import { describe, expect, it } from "vitest";
import { ballotUrlFor, isDigitalVotingOn } from "./digital-voting";

describe("isDigitalVotingOn (#770)", () => {
	it.each([
		[true, false, true],
		[true, true, false],
		[false, false, false],
		[false, true, false],
	])("club enabled %s, meeting disabled %s → %s", (digitalVotingEnabled, digitalVotingDisabled, on) => {
		expect(
			isDigitalVotingOn({ digitalVotingEnabled }, { digitalVotingDisabled }),
		).toBe(on);
	});
});

describe("ballotUrlFor (#770)", () => {
	const meeting = { clubKey: "thr-speaking-club", meetingKey: "2026-09-19" };

	it("is null when the meeting runs no digital vote, whatever the origin", () => {
		expect(ballotUrlFor(false, meeting, "https://gavelup.app")).toBeNull();
		expect(ballotUrlFor(false, meeting, null)).toBeNull();
		expect(ballotUrlFor(false, meeting, "")).toBeNull();
	});

	it("is the absolute ballot URL once the origin is known", () => {
		expect(ballotUrlFor(true, meeting, "https://gavelup.app")).toBe(
			"https://gavelup.app/club/thr-speaking-club/meeting/2026-09-19/vote",
		);
	});

	it("is empty (loading) while the origin is not known yet", () => {
		expect(ballotUrlFor(true, meeting, null)).toBe("");
	});

	it("is the bare path when asked for a relative one", () => {
		expect(ballotUrlFor(true, meeting, "")).toBe(
			"/club/thr-speaking-club/meeting/2026-09-19/vote",
		);
	});
});

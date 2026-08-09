import { describe, expect, it } from "vitest";
import { findVoteCounterSlot } from "./meeting-roles";

describe("findVoteCounterSlot (#510)", () => {
	it("finds the slot by key", () => {
		const slots = [
			{ roleName: "Timer", roleKey: "timer", assignedMemberId: "t" },
			{
				roleName: "Vote Counter",
				roleKey: "vote_counter",
				assignedMemberId: "v",
			},
		];
		expect(findVoteCounterSlot(slots)?.assignedMemberId).toBe("v");
	});

	it("finds a RENAMED vote counter — the key is identity, not the label", () => {
		const slots = [
			{
				roleName: "Ballot Counter",
				roleKey: "vote_counter",
				assignedMemberId: "v",
			},
		];
		expect(findVoteCounterSlot(slots)?.assignedMemberId).toBe("v");
	});

	it("falls back to the exact canonical name for a keyless slot", () => {
		const slots = [
			{ roleName: "Vote Counter", roleKey: null, assignedMemberId: "v" },
		];
		expect(findVoteCounterSlot(slots)?.assignedMemberId).toBe("v");
	});

	it("does NOT match a club-invented look-alike", () => {
		const slots = [
			{
				roleName: "Vote Counter Assistant",
				roleKey: null,
				assignedMemberId: "x",
			},
			{ roleName: "Ballot Counter", roleKey: null, assignedMemberId: "y" },
		];
		expect(findVoteCounterSlot(slots)).toBeUndefined();
	});

	it("prefers the keyed slot over a keyless canonical look-alike", () => {
		const slots = [
			{ roleName: "Vote Counter", roleKey: null, assignedMemberId: "decoy" },
			{
				roleName: "Ballot Counter",
				roleKey: "vote_counter",
				assignedMemberId: "real",
			},
		];
		expect(findVoteCounterSlot(slots)?.assignedMemberId).toBe("real");
	});
});

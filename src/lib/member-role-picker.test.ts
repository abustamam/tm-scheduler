import { describe, expect, it } from "vitest";
import type { SeasonGridData } from "#/server/season-grid";
import { meetingRoleOptions, slotAction } from "./member-role-picker";

describe("slotAction", () => {
	it("maps a slot's state to the mutation", () => {
		expect(slotAction("open")).toBe("assign");
		expect(slotAction("mine")).toBe("release");
		expect(slotAction("other")).toBe("reassign");
	});
});

const data: SeasonGridData = {
	meetings: [],
	members: [],
	memberNames: [
		{ id: "me", name: "Me" },
		{ id: "alex", name: "Alex Rivera" },
	],
	guestNames: [{ id: "g1", name: "Visitor" }],
	rows: [
		{
			roleDefinitionId: "spk",
			slotIndex: 1,
			label: "Speaker 2",
			shortCode: "SP2",
			sortOrder: 3,
			isSpeakerRole: true,
		},
		{
			roleDefinitionId: "tmr",
			slotIndex: 0,
			label: "Timer",
			shortCode: "TMR",
			sortOrder: 6,
			isSpeakerRole: false,
		},
	],
	cells: [
		// Timer: held by "me"
		{
			slotId: "s-tmr",
			meetingId: "m1",
			roleDefinitionId: "tmr",
			slotIndex: 0,
			memberId: "me",
			guestId: null,
			status: "claimed",
		},
		// Speaker 2: held by someone else
		{
			slotId: "s-spk",
			meetingId: "m1",
			roleDefinitionId: "spk",
			slotIndex: 1,
			memberId: "alex",
			guestId: null,
			status: "claimed",
		},
		// A cell in a different meeting — must be excluded
		{
			slotId: "s-other",
			meetingId: "m2",
			roleDefinitionId: "tmr",
			slotIndex: 0,
			memberId: null,
			guestId: null,
			status: "open",
		},
	],
	unavailable: [],
};

describe("meetingRoleOptions", () => {
	it("labels each slot relative to the target member, in agenda order", () => {
		const opts = meetingRoleOptions(data, "m1", "me");
		expect(opts.map((o) => o.shortCode)).toEqual(["SP2", "TMR"]); // sortOrder

		const spk = opts.find((o) => o.slotId === "s-spk");
		expect(spk?.state).toBe("other");
		expect(spk?.holderName).toBe("Alex Rivera");
		expect(spk?.isSpeakerRole).toBe(true);

		const tmr = opts.find((o) => o.slotId === "s-tmr");
		expect(tmr?.state).toBe("mine");
	});

	it("marks an unheld slot open and excludes other meetings", () => {
		const opts = meetingRoleOptions(data, "m1", "someone-else");
		// From "someone-else"'s view, the timer (held by "me") is "other".
		expect(opts.find((o) => o.slotId === "s-tmr")?.state).toBe("other");
		// Only m1's two slots are returned.
		expect(opts).toHaveLength(2);
	});
});

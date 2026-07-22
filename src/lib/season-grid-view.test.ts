import { describe, expect, it } from "vitest";
import type { SeasonGridData } from "#/server/season-grid";
import { memberMeetingStatus, projectGrid } from "./season-grid-view";

const data: SeasonGridData = {
	meetings: [
		{
			id: "m1",
			scheduledAt: "2026-07-01T19:00:00Z",
			timezone: "UTC",
			urlKey: "2026-07-01",
			openCount: 1,
			totalSlots: 2,
			isPast: false,
			isAnchor: true,
			isCompleted: false,
		},
	],
	rows: [
		{
			roleDefinitionId: "tm",
			slotIndex: 0,
			label: "Toastmaster",
			shortCode: "Toas",
			sortOrder: 0,
			isSpeakerRole: false,
		},
		{
			roleDefinitionId: "ti",
			slotIndex: 0,
			label: "Timer",
			shortCode: "Time",
			sortOrder: 1,
			isSpeakerRole: false,
		},
	],
	members: [
		{ id: "a", name: "Amir" },
		{ id: "b", name: "Bea" },
		{ id: "c", name: "Carlos" },
	],
	memberNames: [
		{ id: "a", name: "Amir" },
		{ id: "b", name: "Bea" },
		{ id: "c", name: "Carlos" },
	],
	guestNames: [],
	cells: [
		{
			slotId: "s-tm",
			meetingId: "m1",
			roleDefinitionId: "tm",
			slotIndex: 0,
			memberId: "a",
			guestId: null,
			status: "claimed",
		},
		{
			slotId: "s-ti",
			meetingId: "m1",
			roleDefinitionId: "ti",
			slotIndex: 0,
			memberId: null,
			guestId: null,
			status: "open",
		},
	],
	unavailable: [{ memberId: "b", meetingId: "m1" }],
	contacted: [],
};

describe("projectGrid – roles orientation", () => {
	it("shows member name for assigned and OPEN for empty", () => {
		const rows = projectGrid(data, "roles");
		expect(rows.map((r) => r.label)).toEqual(["Toastmaster", "Timer"]);
		expect(rows[0]!.cells[0]).toMatchObject({ kind: "assigned", text: "Amir" });
		expect(rows[1]!.cells[0]).toMatchObject({ kind: "open", text: "OPEN" });
	});

	it("carries slotId + memberId so cells can claim/release (#198)", () => {
		const rows = projectGrid(data, "roles");
		// Assigned cell: slotId present, memberId = the holder (drives "yours").
		expect(rows[0]!.cells[0]).toMatchObject({
			slotId: "s-tm",
			memberId: "a",
		});
		// OPEN cell: slotId present (claimable), no member yet.
		expect(rows[1]!.cells[0]).toMatchObject({
			slotId: "s-ti",
			memberId: null,
		});
	});

	it("renders an inactive member's name in a past cell (not '—')", () => {
		// "z" is referenced by a cell + present in memberNames, but absent from the
		// active `members` axis — their name must still resolve in roles view.
		const withInactive: SeasonGridData = {
			...data,
			memberNames: [...data.memberNames, { id: "z", name: "Zoe Lapsed" }],
			cells: [
				{
					slotId: "s-tm",
					meetingId: "m1",
					roleDefinitionId: "tm",
					slotIndex: 0,
					memberId: "z",
					status: "claimed",
					guestId: null,
				},
				data.cells[1]!,
			],
		};
		const rows = projectGrid(withInactive, "roles");
		expect(rows[0]!.cells[0]).toMatchObject({
			kind: "assigned",
			text: "Zoe Lapsed",
		});
	});

	it("blank when the meeting lacks a slot for a roles-view row", () => {
		const sparse: SeasonGridData = {
			...data,
			meetings: [
				...data.meetings,
				{
					id: "m2",
					scheduledAt: "2026-07-08T19:00:00Z",
					timezone: "UTC",
					urlKey: "2026-07-08",
					openCount: 0,
					totalSlots: 0,
					isPast: false,
					isAnchor: false,
					isCompleted: false,
				},
			],
		};
		const rows = projectGrid(sparse, "roles");
		expect(rows[0]!.cells[1]).toMatchObject({ kind: "blank" });
	});
});

describe("projectGrid – members orientation", () => {
	it("shows role short code, NA, and free", () => {
		const rows = projectGrid(data, "members");
		const amir = rows.find((r) => r.id === "a")!;
		const bea = rows.find((r) => r.id === "b")!;
		const carlos = rows.find((r) => r.id === "c")!;
		expect(amir.cells[0]).toMatchObject({ kind: "assigned", text: "Toas" });
		expect(bea.cells[0]).toMatchObject({ kind: "na", text: "NA" });
		expect(carlos.cells[0]).toMatchObject({ kind: "free", text: "·" });
	});

	it("does not give an inactive member their own member row", () => {
		// "z" held a role (cell below) but is NOT in the active `members` axis.
		const withInactive: SeasonGridData = {
			...data,
			memberNames: [...data.memberNames, { id: "z", name: "Zoe Lapsed" }],
			cells: [
				...data.cells,
				{
					slotId: "s-tmz",
					meetingId: "m1",
					roleDefinitionId: "tm",
					slotIndex: 0,
					memberId: "z",
					status: "claimed",
					guestId: null,
				},
			],
		};
		const rows = projectGrid(withInactive, "members");
		expect(rows.some((r) => r.id === "z")).toBe(false);
	});

	it("collapses multiple roles in one meeting to first + +N", () => {
		const dbl: SeasonGridData = {
			...data,
			cells: [
				...data.cells,
				{
					slotId: "s-ti-a",
					meetingId: "m1",
					roleDefinitionId: "ti",
					slotIndex: 0,
					memberId: "a",
					status: "claimed",
					guestId: null,
				},
			],
		};
		// re-open the Timer cell so Amir holds both TM and Timer
		dbl.cells = dbl.cells.filter(
			(c) => !(c.roleDefinitionId === "ti" && c.memberId === null),
		);
		const rows = projectGrid(dbl, "members");
		const amir = rows.find((r) => r.id === "a")!;
		expect(amir.cells[0].text).toBe("Toas +1");
		expect(amir.cells[0].title).toContain("Toastmaster");
		expect(amir.cells[0].title).toContain("Timer");
	});
});

describe("memberMeetingStatus", () => {
	it("null member ⇒ empty map", () => {
		expect(memberMeetingStatus(data, null).size).toBe(0);
	});

	it("declined member: declined=true, no roles", () => {
		expect(memberMeetingStatus(data, "b").get("m1")).toEqual({
			declined: true,
			heldRoleLabels: [],
		});
	});

	it("role holder: labels resolved from rows", () => {
		expect(memberMeetingStatus(data, "a").get("m1")).toEqual({
			declined: false,
			heldRoleLabels: ["Toastmaster"],
		});
	});

	it("free member: declined=false, no roles", () => {
		expect(memberMeetingStatus(data, "c").get("m1")).toEqual({
			declined: false,
			heldRoleLabels: [],
		});
	});

	it("collects every held role's label for the meeting", () => {
		const dbl: SeasonGridData = {
			...data,
			cells: [
				data.cells[0]!,
				{
					slotId: "s-ti-a",
					meetingId: "m1",
					roleDefinitionId: "ti",
					slotIndex: 0,
					memberId: "a",
					status: "claimed",
					guestId: null,
				},
			],
		};
		expect(memberMeetingStatus(dbl, "a").get("m1")).toEqual({
			declined: false,
			heldRoleLabels: ["Toastmaster", "Timer"],
		});
	});
});

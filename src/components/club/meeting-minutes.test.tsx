// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinutesResult } from "#/server/minutes";
import type { MinutesProgramRow } from "#/server/minutes-logic";
import { MeetingMinutes } from "./meeting-minutes";

// The component imports the minutes server-fn module, which pulls in `#/db`
// transitively. Those handlers never run in this render-only test, so stub the
// db client to avoid the eager "DATABASE_URL is not set" throw at import time.
vi.mock("#/db", () => ({ db: {} }));

type MinutesData = NonNullable<MinutesResult["data"]>;

const emptyMinutes: MinutesData = {
	actionItems: { open: [], resolved: [], openTotal: 0, resolvedTotal: 0 },
	meetingId: "m1",
	clubId: "c1",
	members: [],
	guests: [],
	tableTopicsSpeakers: [],
	awards: [],
	awardEligible: {
		best_speaker: { memberIds: [], guestIds: [] },
		best_evaluator: { memberIds: [], guestIds: [] },
		best_table_topics: { memberIds: [], guestIds: [] },
	},
	counts: { present: 0, absent: 0, excused: 0, unmarked: 0, guests: 0 },
};

function programRow(over: Partial<MinutesProgramRow>): MinutesProgramRow {
	return {
		slotId: "s1",
		roleName: "Timer",
		category: "functionary",
		assigneeName: null,
		isGuest: false,
		speechTitle: null,
		...over,
	};
}

function renderMinutes(program: MinutesProgramRow[], meetingPast: boolean) {
	return render(
		<MeetingMinutes
			meetingId="m1"
			minutes={emptyMinutes}
			program={program}
			meetingPast={meetingPast}
			canEdit={false}
			clubGuests={[]}
			onMutated={() => {}}
		/>,
	);
}

describe("MeetingMinutes Program render condition (#225)", () => {
	afterEach(() => cleanup());

	it("hides the Program block on a future meeting with zero assignees", () => {
		renderMinutes(
			[
				programRow({ slotId: "s1", roleName: "Timer" }),
				programRow({ slotId: "s2", roleName: "Grammarian" }),
			],
			false,
		);
		expect(screen.queryByText("Program")).toBeNull();
	});

	it("shows the Program block once at least one role is assigned", () => {
		renderMinutes(
			[
				programRow({ slotId: "s1", roleName: "Timer", assigneeName: "Ana" }),
				programRow({ slotId: "s2", roleName: "Grammarian" }),
			],
			false,
		);
		expect(screen.getByText("Program")).toBeTruthy();
		expect(screen.getByText(/Ana/)).toBeTruthy();
		// Unassigned rows still show their placeholder inside a visible block.
		expect(screen.getByText("Grammarian:")).toBeTruthy();
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("shows the Program block on a past/completed meeting even with zero assignees", () => {
		renderMinutes([programRow({ slotId: "s1", roleName: "Timer" })], true);
		expect(screen.getByText("Program")).toBeTruthy();
	});

	it("renders no Program block when the meeting has no program rows at all", () => {
		renderMinutes([], true);
		expect(screen.queryByText("Program")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Club action items (#529)
//
// Written after mutation testing showed the whole section could be deleted with
// all 3,236 tests green: the only fixture change the feature made here was
// adding an EMPTY `actionItems`, which takes the component's early return in
// every existing test.
// ---------------------------------------------------------------------------

type ActionItemFixture = MinutesData["actionItems"]["open"][number];

function actionItem(over: Partial<ActionItemFixture>): ActionItemFixture {
	return {
		id: "a1",
		text: "Book the venue",
		ownerMemberId: null,
		ownerName: null,
		dueDate: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		resolvedAt: null,
		resolution: null,
		...over,
	};
}

function renderWithActionItems(actionItems: MinutesData["actionItems"]) {
	return render(
		<MeetingMinutes
			meetingId="m1"
			minutes={{ ...emptyMinutes, actionItems }}
			program={[]}
			meetingPast={true}
			canEdit={false}
			clubGuests={[]}
			onMutated={() => {}}
		/>,
	);
}

describe("MeetingMinutes action items (#529)", () => {
	afterEach(() => cleanup());

	it("renders an UNOWNED item with no owner name at all", () => {
		// The acceptance criterion, and the thing three surfaces got wrong: a
		// placeholder reads as an owner. "The club" in particular turns a departed
		// owner's personal commitment into a club-wide one.
		renderWithActionItems({
			open: [actionItem({ id: "a", text: "Everyone bring a guest" })],
			resolved: [],
			openTotal: 1,
			resolvedTotal: 0,
		});
		expect(screen.getByText("Everyone bring a guest")).toBeTruthy();
		expect(screen.queryByText(/The club/)).toBeNull();
	});

	it("names the owner when there is one, and prints the due date as picked", () => {
		renderWithActionItems({
			open: [
				actionItem({ id: "a", ownerName: "Jane Doe", dueDate: "2026-08-10" }),
			],
			resolved: [],
			openTotal: 1,
			resolvedTotal: 0,
		});
		expect(screen.getByText(/Jane Doe/)).toBeTruthy();
		// "Aug 10", never "Aug 9" — the due date is a calendar day, not an instant.
		expect(screen.getByText(/Aug 10/)).toBeTruthy();
	});

	it("shows what closed since the last meeting, with the reason spelled out", () => {
		renderWithActionItems({
			open: [],
			resolved: [
				actionItem({
					id: "c",
					text: "Order ribbons",
					resolvedAt: new Date("2026-02-01T00:00:00Z"),
					resolution: "dropped",
				}),
			],
			openTotal: 0,
			resolvedTotal: 1,
		});
		expect(screen.getByText(/Closed since the last meeting/i)).toBeTruthy();
		expect(screen.getByText("Order ribbons")).toBeTruthy();
		// A spelled-out word, not the raw enum value.
		expect(screen.getByText(/Dropped/)).toBeTruthy();
	});

	it("says how many rows the cap hid, so a bounded list is not read as complete", () => {
		renderWithActionItems({
			open: [actionItem({ id: "a" })],
			resolved: [],
			openTotal: 12,
			resolvedTotal: 0,
		});
		expect(screen.getByText(/11 more not shown/)).toBeTruthy();
	});

	it("renders no action-item section when both lists are empty", () => {
		renderWithActionItems({
			open: [],
			resolved: [],
			openTotal: 0,
			resolvedTotal: 0,
		});
		expect(screen.queryByText("Action items")).toBeNull();
	});

	it("survives an offline snapshot written before action items existed", () => {
		// `readSnapshot` returns an unversioned `MinutesData` persisted by a
		// PREVIOUS deploy, with no shape check. Without the guard this throws on
		// `items.open` and white-screens the whole minutes page — for the secretary
		// who just lost signal mid-meeting, which is the case the offline queue is
		// for.
		const legacy = { ...emptyMinutes } as Record<string, unknown>;
		delete legacy.actionItems;
		expect(() =>
			render(
				<MeetingMinutes
					meetingId="m1"
					minutes={legacy as unknown as MinutesData}
					program={[]}
					meetingPast={true}
					canEdit={false}
					clubGuests={[]}
					onMutated={() => {}}
				/>,
			),
		).not.toThrow();
	});
});

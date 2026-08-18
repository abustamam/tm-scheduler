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
			meetingDayReached={true}
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
			meetingDayReached={true}
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
					meetingDayReached={true}
					canEdit={false}
					clubGuests={[]}
					onMutated={() => {}}
				/>,
			),
		).not.toThrow();
	});
});

describe("MeetingMinutes attendance moved to the panel", () => {
	afterEach(() => cleanup());

	// Roll call now lives in the attendance panel beside the agenda, so this card
	// WRITES none of it. Two things survive here and are covered by nothing else:
	// the card's own copy, which still switches on the meeting day; and — for a
	// viewer who cannot edit — the read-only record, because the panel is
	// admin-only and a plain member seeing a completed meeting's minutes is the
	// largest audience the minutes have.
	//
	// The fixture keeps members, a guest and non-zero counts on purpose. It is
	// what makes the negatives below real assertions rather than vacuous ones — a
	// recorder re-added to this card would render "Ayesha Khan" and its three
	// buttons, and fail.
	//
	// Every count is a DIFFERENT number so a badge wired to the wrong field is
	// visible. Five badges reading the same 0 would agree with each other however
	// they were crossed. They deliberately do not add up to the member list; this
	// component renders the counts it is handed and derives nothing.
	function renderCard(opts: { meetingDayReached: boolean; canEdit: boolean }) {
		return render(
			<MeetingMinutes
				meetingId="m1"
				minutes={{
					...emptyMinutes,
					members: [
						{
							memberId: "mem1",
							name: "Ayesha Khan",
							status: null,
							hasRole: false,
						},
						{
							memberId: "mem2",
							name: "Bo Chen",
							status: "excused",
							hasRole: false,
						},
					],
					guests: [{ guestId: "g1", name: "Dana Reed", fromRole: false }],
					counts: {
						present: 3,
						absent: 4,
						excused: 1,
						unmarked: 2,
						guests: 5,
					},
				}}
				program={[]}
				meetingPast={false}
				meetingDayReached={opts.meetingDayReached}
				canEdit={opts.canEdit}
				clubGuests={[]}
				onMutated={() => {}}
			/>,
		);
	}

	const renderOnDay = (meetingDayReached: boolean) =>
		renderCard({ meetingDayReached, canEdit: true });

	it("says why there is nothing to see before the meeting day", () => {
		const { getByText, queryByText } = renderOnDay(false);
		expect(getByText(/Opens on the day of the meeting/i)).toBeTruthy();
		// And the card must stop claiming to be a record of what happened.
		expect(getByText(/Attendance opens on the day/i)).toBeTruthy();
		// Before the day there is no panel to point at either — the pointer belongs
		// to the other branch, and showing it here would send an officer looking for
		// a surface the route has not rendered yet.
		expect(
			queryByText(/Attendance is taken in the Attendance panel/i),
		).toBeNull();
	});

	it("points at the panel on the meeting day instead of recording anything", () => {
		// The positive control for the negatives below: without it, a component
		// that rendered nothing at all would pass them for the wrong reason.
		const { getByText } = renderOnDay(true);
		expect(
			getByText(
				/Attendance is taken in the Attendance panel, beside the agenda/i,
			),
		).toBeTruthy();
		expect(getByText(/the record of what happened/i)).toBeTruthy();
	});

	it("gives a viewer who cannot edit the record itself, not a pointer", () => {
		// F1. The panel's roll mode is gated to signed-in admins, but this card is
		// visible to any member once the meeting is `completed`
		// (`getMinutes`: `visible = canEdit || status === "completed"`). Deleting
		// the recorder must not take "who was at this meeting?" away from them.
		const { getByText } = renderCard({
			meetingDayReached: true,
			canEdit: false,
		});
		// The counts line, each badge read by its own number so a crossed pair
		// fails rather than agreeing with itself.
		expect(getByText("3 present")).toBeTruthy();
		expect(getByText("1 excused")).toBeTruthy();
		expect(getByText("4 absent")).toBeTruthy();
		expect(getByText("2 unmarked")).toBeTruthy();
		// The guests count had no equivalent anywhere after the deletion — the
		// panel lists guests by name and never totals them.
		expect(getByText("5 guests")).toBeTruthy();
		// One row per member, carrying the status.
		expect(getByText("Ayesha Khan")).toBeTruthy();
		expect(getByText("Bo Chen")).toBeTruthy();
		expect(getByText("Excused")).toBeTruthy();
		// Unmarked is the ABSENCE of a record, never a synonym for absent (#218).
		expect(getByText("Unmarked")).toBeTruthy();
		// And the guests by name, as the old read-only arm showed them.
		expect(getByText("Dana Reed")).toBeTruthy();
	});

	it("does not point a read-only viewer at a panel they cannot see", () => {
		// F2. The sentence is true for an admin and false for everyone else — this
		// viewer has no attendance panel beside the agenda, so telling them roll
		// call happens there sends them looking for a surface that is not rendered.
		const { queryByText } = renderCard({
			meetingDayReached: true,
			canEdit: false,
		});
		expect(
			queryByText(/Attendance is taken in the Attendance panel/i),
		).toBeNull();
	});

	it("records no attendance itself — no write control, either audience", () => {
		// The absorption, asserted where a source guard cannot see it: the guard
		// pins that the symbol is gone and that the three write fns are unnamed,
		// this pins that no roll-call CONTROL reaches the DOM. Two surfaces writing
		// the same rows is how a club ends up with someone marked present in one
		// place and absent in the other.
		//
		// Both audiences, because they render different things: the admin gets a
		// pointer and the read-only viewer gets the record. The record is the one
		// that could quietly grow a button back, which is exactly why `canEdit:
		// false` is in this matrix rather than trusted to be inert.
		for (const canEdit of [true, false]) {
			for (const meetingDayReached of [true, false]) {
				const { queryByRole } = renderCard({ meetingDayReached, canEdit });
				const where = `canEdit=${canEdit} meetingDayReached=${meetingDayReached}`;
				// Status words may appear as TEXT in the read-only record (a Badge is
				// a span) — what must never exist is a control that writes them.
				expect(queryByRole("button", { name: "Present" }), where).toBeNull();
				expect(queryByRole("button", { name: "Excused" }), where).toBeNull();
				expect(queryByRole("button", { name: "Absent" }), where).toBeNull();
				// Neither half of the old section's guest controls.
				expect(queryByRole("button", { name: /Add guest/i }), where).toBeNull();
				expect(queryByRole("button", { name: /^Remove/i }), where).toBeNull();
				cleanup();
			}
		}
	});

	it("shows an admin the pointer and no roster, so there is one recorder", () => {
		// The other side of the branch: an admin must NOT get a second copy of the
		// roster here, or the surface the panel replaced is effectively back.
		const { queryByText } = renderCard({
			meetingDayReached: true,
			canEdit: true,
		});
		expect(queryByText("Ayesha Khan")).toBeNull();
		expect(queryByText("Bo Chen")).toBeNull();
		expect(queryByText("3 present")).toBeNull();
	});
});

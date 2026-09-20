// @vitest-environment jsdom
//
// The diff table draws a create and an update differently (#808).
//
// The page's whole job is that a reader can see what 52 dates would DO before
// they happen, and the two branches are not interchangeable: a create writes a
// new meeting with whatever meta was named, an update moves named fields on a
// meeting that already exists, and a line that moves nothing writes nothing at
// all. A table that rendered all three the same way would be a confirm page
// that confirms nothing — and every server-side assertion would still pass,
// because the plan it is handed is correct.
//
// It also pins the ORDER. A blocked date produces no plan line, so the blocked
// rows arrive in a separate list; rendering the two lists one after the other
// would put the problems at the bottom in an order nobody chose, while the
// reader is checking against a list of dates they just said out loud.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgendaPlanLine } from "#/server/agenda-plan";
import type { AgendaBlockingItem } from "#/server/agenda-plan-pending-logic";
import { AgendaDiffTable } from "./agenda-diff-table";

afterEach(cleanup);

const CREATE: AgendaPlanLine = {
	index: 0,
	date: "2027-03-02",
	weekday: "Tuesday",
	warnings: [],
	action: "create",
	time: "19:00",
	location: "The usual hall",
	meta: {
		theme: "Harvest",
		wordOfTheDay: "ebullient",
		wodDefinition: null,
		wodExample: null,
	},
};

const UPDATE: AgendaPlanLine = {
	index: 1,
	date: "2027-03-09",
	weekday: "Tuesday",
	warnings: [],
	action: "update",
	meetingId: "m-1",
	time: "19:00",
	changes: [{ field: "theme", from: "Old", to: "Autumn" }],
};

const NO_CHANGE: AgendaPlanLine = {
	index: 2,
	date: "2027-03-16",
	weekday: "Tuesday",
	warnings: [],
	action: "update",
	meetingId: "m-2",
	time: "19:00",
	changes: [],
};

function rows() {
	return screen.getAllByTestId("agenda-diff-row");
}

describe("AgendaDiffTable", () => {
	it("says which of the three things each line does", () => {
		render(
			<AgendaDiffTable
				lines={[CREATE, UPDATE, NO_CHANGE]}
				blocking={[]}
				meetingNumbers={{}}
			/>,
		);
		const [create, update, unchanged] = rows();
		expect(within(create as HTMLElement).getByText("New meeting")).toBeTruthy();
		expect(within(update as HTMLElement).getByText("Update")).toBeTruthy();
		expect(
			within(unchanged as HTMLElement).getByText("No change"),
		).toBeTruthy();
	});

	it("renders an update as a from → to diff, with the field named", () => {
		render(
			<AgendaDiffTable lines={[UPDATE]} blocking={[]} meetingNumbers={{}} />,
		);
		const row = rows()[0] as HTMLElement;
		expect(within(row).getByText("Theme")).toBeTruthy();
		expect(within(row).getByText("Old")).toBeTruthy();
		expect(within(row).getByText("Autumn")).toBeTruthy();
		// The arrow reads as nothing to a screen reader, so the word is there
		// too. It is also what makes the scroller's `relative` load-bearing —
		// `sr-only` is `position:absolute`. See the geometry suite.
		expect(within(row).getByText(/becomes/)).toBeTruthy();
	});

	it("shows an empty column as (empty) rather than as blank space", () => {
		// A diff whose `from` is null must not look like a diff with no `from`:
		// "the theme was nothing" and "this row is cut off" are different facts.
		render(
			<AgendaDiffTable
				lines={[
					{
						...UPDATE,
						changes: [{ field: "theme", from: null, to: "Autumn" }],
					},
				]}
				blocking={[]}
				meetingNumbers={{}}
			/>,
		);
		expect(screen.getByText("(empty)")).toBeTruthy();
	});

	it("lists what a create would write, and says so when it would write nothing", () => {
		render(
			<AgendaDiffTable lines={[CREATE]} blocking={[]} meetingNumbers={{}} />,
		);
		expect(screen.getByText("Word of the Day")).toBeTruthy();
		expect(screen.getByText(/ebullient/)).toBeTruthy();

		cleanup();
		render(
			<AgendaDiffTable
				lines={[
					{
						...CREATE,
						location: null,
						meta: {
							theme: null,
							wordOfTheDay: null,
							wodDefinition: null,
							wodExample: null,
						},
					},
				]}
				blocking={[]}
				meetingNumbers={{}}
			/>,
		);
		expect(screen.getByText(/blank meeting/)).toBeTruthy();
	});

	it("shows a provisional meeting number only where one exists", () => {
		render(
			<AgendaDiffTable
				lines={[CREATE, UPDATE]}
				blocking={[]}
				meetingNumbers={{ 1: 41 }}
			/>,
		);
		const [create, update] = rows();
		expect(within(update as HTMLElement).getByText("provisional")).toBeTruthy();
		expect(within(update as HTMLElement).getByText(/41/)).toBeTruthy();
		// A create has no meeting yet, so there is no number to derive — and this
		// tool never WRITES one (#358).
		expect(within(create as HTMLElement).queryByText("provisional")).toBeNull();
	});

	it("renders each warning in words", () => {
		render(
			<AgendaDiffTable
				lines={[
					{
						...UPDATE,
						warnings: ["weekday_mismatch", "time_ignored", "meeting_cancelled"],
					},
				]}
				blocking={[]}
				meetingNumbers={{}}
			/>,
		);
		expect(screen.getByText(/usual weekday/)).toBeTruthy();
		expect(screen.getByText(/time it already has/)).toBeTruthy();
		expect(screen.getByText(/cancelled/)).toBeTruthy();
	});

	it("puts a blocked date back in the position it was asked in", () => {
		const blocked: AgendaBlockingItem = {
			code: "AMBIGUOUS_DATE",
			message: "2027-03-05 names more than one meeting of this club.",
			entryIndex: 1,
			date: "2027-03-05",
		};
		render(
			<AgendaDiffTable
				lines={[CREATE, { ...UPDATE, index: 2 }]}
				blocking={[blocked]}
				meetingNumbers={{}}
			/>,
		);
		const dates = rows().map(
			(row) => within(row as HTMLElement).getAllByRole("cell")[0]?.textContent,
		);
		expect(dates?.[0]).toContain("2027-03-02");
		expect(dates?.[1]).toContain("2027-03-05");
		expect(dates?.[2]).toContain("2027-03-09");
	});

	it("keeps a call-wide blocking item out of the table", () => {
		// An item with no `entryIndex` belongs to the call rather than to a date,
		// and the page renders it above the table. A row for it would have no
		// date to sit under.
		render(
			<AgendaDiffTable
				lines={[CREATE]}
				blocking={[
					{
						code: "AMBIGUOUS_DATE",
						message: "something about the call",
						entryIndex: null,
						date: null,
					},
				]}
				meetingNumbers={{}}
			/>,
		);
		expect(rows()).toHaveLength(1);
		expect(screen.queryByText("something about the call")).toBeNull();
	});
});

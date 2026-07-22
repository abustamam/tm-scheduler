// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineRow } from "#/lib/agenda-timing";
import {
	type AgendaHeader,
	type AgendaLayout,
	MeetingAgendaPrint,
} from "./meeting-agenda-print";

afterEach(cleanup);

const header: AgendaHeader = {
	clubName: "Downtown Toastmasters",
	clubNumber: "1234",
	district: "District 5",
	mission: null,
	meetingSchedule: null,
	dateLong: "Wednesday, July 22, 2026",
	dateShort: "Wed · Jul 22, 2026",
	timeRange: "7:00 – 8:15 PM",
	theme: "New Horizons",
	wordOfTheDay: "Ebullient",
	location: null,
};

// One timed speaker beat (has green/amber/red marks) + one plain beat (no marks).
const rows: TimelineRow[] = [
	{
		who: "Toastmaster",
		detail: "Opens the meeting",
		minutes: 5,
		marks: null,
		time: "7:00",
	},
	{
		who: "Speaker 1 · Jane Doe",
		detail: "Ice Breaker",
		minutes: 6,
		marks: { green: 4, yellow: 5, red: 6 },
		time: "7:10",
	},
];

function renderLayout(layout: AgendaLayout) {
	return render(
		<MeetingAgendaPrint
			layout={layout}
			header={header}
			roles={[{ label: "Toastmaster", name: "Lee P." }]}
			officers={[]}
			explainers={[]}
			rows={rows}
		/>,
	);
}

describe("MeetingAgendaPrint one-page timing", () => {
	for (const layout of ["grid", "editorial"] as const) {
		it(`shows the color-coded green/amber/red trio on the ${layout} one-pager`, () => {
			renderLayout(layout);
			// green = 4:00, amber = 5:00, red = 6:00 for the timed speaker beat.
			expect(screen.getByText("4:00")).toBeTruthy();
			expect(screen.getByText("5:00")).toBeTruthy();
			expect(screen.getByText("6:00")).toBeTruthy();
		});

		it(`shows the timing-signals legend on the ${layout} one-pager`, () => {
			renderLayout(layout);
			expect(screen.getByText("Min reached")).toBeTruthy();
			expect(screen.getByText("Approaching")).toBeTruthy();
			expect(screen.getByText("Wrap up")).toBeTruthy();
		});
	}
});

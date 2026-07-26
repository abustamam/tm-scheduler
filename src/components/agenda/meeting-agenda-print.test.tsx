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
	announcements: null,
	meetingNumber: null,
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

		// #357 — the grace period, with this agenda's own numbers (4:00–6:00 ⇒
		// qualifies 3:30–6:30), not a hardcoded 5–7 example.
		it(`states the 30-second grace window on the ${layout} one-pager`, () => {
			renderLayout(layout);
			expect(
				screen.getByText(
					"±0:30 grace — e.g. a 4:00–6:00 speech qualifies 3:30–6:30",
				),
			).toBeTruthy();
		});

		it(`falls back to the bare grace rule on the ${layout} one-pager when nothing is timed`, () => {
			render(
				<MeetingAgendaPrint
					layout={layout}
					header={header}
					roles={[{ label: "Toastmaster", name: "Lee P." }]}
					officers={[]}
					explainers={[]}
					rows={rows.map((r) => ({ ...r, marks: null }))}
				/>,
			);
			expect(
				screen.getByText(
					"±0:30 grace — 0:30 before green through 0:30 after red",
				),
			).toBeTruthy();
		});
	}
});

// #357 — the two-page timing layout has room to spell the rule out in full.
describe("MeetingAgendaPrint timing-signals callout", () => {
	it("states the qualifying window in the Timing Signals callout", () => {
		renderLayout("timing");
		expect(
			screen.getByText(
				"A speech qualifies from 0:30 before green through 0:30 after red — a 4:00–6:00 speech qualifies between 3:30 and 6:30.",
			),
		).toBeTruthy();
	});

	it("still states the rule when no beat is timed", () => {
		render(
			<MeetingAgendaPrint
				layout="timing"
				header={header}
				roles={[{ label: "Toastmaster", name: "Lee P." }]}
				officers={[]}
				explainers={[]}
				rows={rows.map((r) => ({ ...r, marks: null }))}
			/>,
		);
		expect(
			screen.getByText(
				"A speech qualifies from 0:30 before green through 0:30 after red.",
			),
		).toBeTruthy();
	});
});

describe("MeetingAgendaPrint announcements", () => {
	const withAnnouncements: AgendaHeader = {
		...header,
		announcements: "Bring a guest\n\nRenew your dues",
	};

	function renderWith(layout: AgendaLayout, h: AgendaHeader) {
		return render(
			<MeetingAgendaPrint
				layout={layout}
				header={h}
				roles={[{ label: "Toastmaster", name: "Lee P." }]}
				officers={[]}
				explainers={[]}
				rows={rows}
			/>,
		);
	}

	for (const layout of ["grid", "editorial"] as const) {
		it(`renders the announcements list on the ${layout} one-pager`, () => {
			renderWith(layout, withAnnouncements);
			expect(screen.getAllByText("Announcements").length).toBeGreaterThan(0);
			expect(screen.getByText("Bring a guest")).toBeTruthy();
			expect(screen.getByText("Renew your dues")).toBeTruthy();
		});

		it(`renders no announcements on the ${layout} one-pager when empty`, () => {
			renderWith(layout, header);
			expect(screen.queryByText("Bring a guest")).toBeNull();
		});
	}

	// #358 — the club's own meeting number, on every layout.
	const withNumber: AgendaHeader = { ...header, meetingNumber: 56 };

	for (const layout of ["grid", "editorial", "spacious", "timing"] as const) {
		it(`${layout}: prints the meeting number when the club has one`, () => {
			renderWith(layout, withNumber);
			expect(screen.getByText(/Meeting #56/)).toBeTruthy();
		});

		it(`${layout}: prints no meeting-number label when there is none`, () => {
			renderWith(layout, header);
			expect(screen.queryByText(/Meeting #/)).toBeNull();
		});
	}

	for (const layout of ["spacious", "timing"] as const) {
		it(`${layout}: announcements replace the ruled Meeting Notes lines when present`, () => {
			renderWith(layout, withAnnouncements);
			expect(screen.getByText("Bring a guest")).toBeTruthy();
			expect(screen.queryByText("Meeting Notes")).toBeNull();
			expect(screen.getByText(/Tonight.s Votes/)).toBeTruthy();
		});

		it(`${layout}: keeps the Meeting Notes lines when there are no announcements`, () => {
			renderWith(layout, header);
			expect(screen.getByText("Meeting Notes")).toBeTruthy();
			expect(screen.queryByText("Bring a guest")).toBeNull();
			expect(screen.getByText(/Tonight.s Votes/)).toBeTruthy();
		});
	}
});

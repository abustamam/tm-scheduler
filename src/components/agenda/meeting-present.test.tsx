// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Slide } from "#/lib/agenda-slides";
import { MeetingPresent } from "./meeting-present";

const CLUB_NAME = "MCF Toastmasters Club";

const deck: Slide[] = [
	{
		kind: "title",
		clubName: CLUB_NAME,
		district: "District 39",
		clubNumber: "28677176",
		scheduledAt: new Date("2026-06-25T23:45:00Z"),
		timezone: "America/Chicago",
	},
	{
		kind: "wordOfDay",
		word: "Serendipity",
		definition: "A fortunate happenstance.",
		example: "Meeting my mentor was pure serendipity.",
	},
	{ kind: "voteSpeaker", names: ["Jane Doe"] },
	{
		kind: "thankYou",
		meetingSchedule: "2nd & 4th Thursday",
		nextMeetingAt: null,
		timezone: "America/Chicago",
	},
];

function clickNext() {
	fireEvent.click(screen.getByLabelText("Next slide"));
}

describe("MeetingPresent", () => {
	afterEach(() => cleanup());

	it("renders the title slide's club name as the splash headline", () => {
		render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
		expect(screen.getByText(CLUB_NAME)).toBeTruthy();
	});

	it("shows a slide position indicator", () => {
		render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
		expect(screen.getByText("1 / 4")).toBeTruthy();
	});

	it("shows the section-title header on a content slide, unprefixed by the club name, while the club name still appears in the footer", () => {
		render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
		clickNext(); // -> wordOfDay

		// Exact match proves the header is just the section title, not
		// "<clubName>: Word of the Day" or similar.
		expect(screen.getByText("Word of the Day")).toBeTruthy();

		// The club name now lives in the footer, not a running per-slide header.
		expect(screen.getAllByText(CLUB_NAME).length).toBeGreaterThanOrEqual(1);
	});

	it("renders the vote prompt on a vote slide", () => {
		render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
		clickNext(); // -> wordOfDay
		clickNext(); // -> voteSpeaker

		expect(screen.getByText("Please Vote for Best Speaker:")).toBeTruthy();
	});

	it("shows Thank You on the closing splash slide", () => {
		render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
		clickNext(); // -> wordOfDay
		clickNext(); // -> voteSpeaker
		clickNext(); // -> thankYou

		expect(screen.getByText("Thank You")).toBeTruthy();
	});
});

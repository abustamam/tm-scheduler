// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Slide } from "#/lib/agenda-slides";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { MeetingPresent } from "./meeting-present";

const CLUB_NAME = "MCF Toastmasters Club";

const deck: Slide[] = [
	{
		kind: "title",
		clubName: CLUB_NAME,
		district: "District 39",
		clubNumber: "28677176",
		meetingNumber: null,
		scheduledAt: new Date("2026-06-25T23:45:00Z"),
		timezone: "America/Chicago",
	},
	{
		kind: "wordOfDay",
		word: "Serendipity",
		definition: "A fortunate happenstance.",
		example: "Meeting my mentor was pure serendipity.",
		presenter: { role: "Grammarian", name: "Mona" },
	},
	{ kind: "voteSpeaker", names: ["Jane Doe"], hasTimer: true },
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

function press(key: string) {
	fireEvent.keyDown(window, { key });
}

/** The overview overlay, or null when it is closed. */
function overview() {
	return screen.queryByRole("dialog", { name: "Jump to a slide" });
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

	it("credits the Grammarian on the Word of the Day slide (#354)", () => {
		render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
		clickNext(); // -> wordOfDay

		expect(screen.getByText("Presented by the Grammarian · Mona")).toBeTruthy();
	});

	it("shows the Toastmasters non-affiliation disclaimer in the content-slide footer", () => {
		render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
		clickNext(); // -> wordOfDay (content slide with footer)

		expect(screen.getByText(TOASTMASTERS_DISCLAIMER)).toBeTruthy();
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

	// #360 — arrowing through twenty slides in front of the room is not a
	// navigation model. The overview must be invisible until asked for, so the
	// projection is unchanged during normal use.
	describe("slide overview (#360)", () => {
		it("is hidden until it is invoked", () => {
			render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);

			expect(overview()).toBeNull();
			// Nothing from a later slide is on screen either.
			expect(screen.queryByText("Vote for Best Speaker")).toBeNull();
		});

		it("opens on `b` and lists every slide by its header", () => {
			render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
			press("b");

			const panel = overview();
			expect(panel).toBeTruthy();
			const items = within(panel as HTMLElement).getAllByRole("button", {
				name: /^Slide \d+:/,
			});
			expect(items.map((b) => b.getAttribute("aria-label"))).toEqual([
				`Slide 1: ${CLUB_NAME}`,
				"Slide 2: Word of the Day",
				"Slide 3: Vote for Best Speaker",
				"Slide 4: Thank You",
			]);
		});

		it("also opens on `o` and from the slide counter", () => {
			render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
			press("o");
			expect(overview()).toBeTruthy();
			press("Escape");
			expect(overview()).toBeNull();

			fireEvent.click(screen.getByText("1 / 4"));
			expect(overview()).toBeTruthy();
		});

		it("jumps straight to a chosen slide and closes", () => {
			render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
			press("b");
			fireEvent.click(
				screen.getByRole("button", { name: "Slide 3: Vote for Best Speaker" }),
			);

			expect(overview()).toBeNull();
			expect(screen.getByText("3 / 4")).toBeTruthy();
			expect(screen.getByText("Please Vote for Best Speaker:")).toBeTruthy();
		});

		it("closes on Escape without changing position or exiting present mode", () => {
			const onExit = vi.fn();
			render(
				<MeetingPresent deck={deck} clubName={CLUB_NAME} onExit={onExit} />,
			);
			clickNext(); // -> wordOfDay
			press("b");
			// Move the highlight around; Escape must still discard it.
			press("ArrowRight");
			press("ArrowRight");
			press("Escape");

			expect(overview()).toBeNull();
			expect(screen.getByText("2 / 4")).toBeTruthy();
			expect(screen.getByText("Word of the Day")).toBeTruthy();
			// Escape closed the overview; it did not also leave the deck.
			expect(onExit).not.toHaveBeenCalled();
		});

		it("navigates the overview with the arrow keys and commits on Enter", () => {
			render(<MeetingPresent deck={deck} clubName={CLUB_NAME} />);
			press("b");
			press("ArrowRight");
			press("ArrowRight");
			// The deck itself has not moved while the overview is open.
			expect(screen.getByText("1 / 4")).toBeTruthy();
			press("Enter");

			expect(overview()).toBeNull();
			expect(screen.getByText("3 / 4")).toBeTruthy();
		});

		it("still exits present mode on Escape when the overview is closed", () => {
			const onExit = vi.fn();
			render(
				<MeetingPresent deck={deck} clubName={CLUB_NAME} onExit={onExit} />,
			);
			press("Escape");

			expect(onExit).toHaveBeenCalledTimes(1);
		});
	});
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Slide } from "#/lib/agenda-slides";
import { MeetingPresent } from "./meeting-present";

const deck: Slide[] = [
	{
		kind: "title",
		clubName: "MCF Toastmasters Club",
		district: "District 39",
		clubNumber: "28677176",
		scheduledAt: new Date("2026-06-25T23:45:00Z"),
		timezone: "America/Chicago",
	},
	{ kind: "toastmaster", name: "Schinthia Islam" },
	{ kind: "thankYou", meetingSchedule: "2nd & 4th Thursday" },
];

describe("MeetingPresent", () => {
	afterEach(() => cleanup());

	it("renders the first slide's club name", () => {
		render(<MeetingPresent deck={deck} />);
		expect(screen.getByText("MCF Toastmasters Club")).toBeTruthy();
	});

	it("shows a slide position indicator", () => {
		render(<MeetingPresent deck={deck} />);
		expect(screen.getByText("1 / 3")).toBeTruthy();
	});
});

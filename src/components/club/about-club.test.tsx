// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicClubProfile } from "#/server/clubs-logic";
import { AboutClub } from "./about-club";

afterEach(cleanup);

const EMPTY: PublicClubProfile = {
	district: null,
	mission: null,
	meetingSchedule: null,
};

function renderAbout(profile: PublicClubProfile | null) {
	const { container } = render(
		<AboutClub clubName="Harbor City Speakers" profile={profile} />,
	);
	return container;
}

describe("AboutClub", () => {
	it("shows the meeting schedule a guest needs", () => {
		renderAbout({ ...EMPTY, meetingSchedule: "2nd & 4th Thursday, 6:45 PM" });
		expect(screen.getByText(/2nd & 4th Thursday, 6:45 PM/)).toBeTruthy();
	});

	it("shows district and mission when set", () => {
		renderAbout({
			district: "District 206",
			mission: "Building leaders.",
			meetingSchedule: "Thursdays",
		});
		expect(screen.getByText("District 206")).toBeTruthy();
		expect(screen.getByText("Building leaders.")).toBeTruthy();
		expect(screen.getByText("Thursdays")).toBeTruthy();
	});

	// The printed agenda "falls back gracefully (no empty labels)" for these same
	// fields. An empty card with a heading and nothing under it is worse than no
	// card, so assert on the RENDERED OUTPUT being empty rather than on a flag.
	it("renders nothing at all when every field is unset", () => {
		expect(renderAbout(EMPTY).innerHTML).toBe("");
	});

	it("renders nothing when the club has no profile row", () => {
		expect(renderAbout(null).innerHTML).toBe("");
	});

	// `emptyToNull` normalizes on write, but rows seeded or imported before that
	// normalization can still hold blanks — a whitespace-only value must not
	// produce a card with an invisible entry in it.
	it("treats whitespace-only values as unset", () => {
		expect(
			renderAbout({
				district: "   ",
				mission: "\n\t ",
				meetingSchedule: "  ",
			}).innerHTML,
		).toBe("");
	});

	it("still renders when only ONE field is set", () => {
		expect(
			renderAbout({ ...EMPTY, district: "District 206" }).innerHTML,
		).not.toBe("");
		cleanup();
		expect(renderAbout({ ...EMPTY, mission: "Grow." }).innerHTML).not.toBe("");
	});

	// `clubs.mission` is documented as free text that "may be multi-line".
	it("preserves line breaks in a multi-line mission", () => {
		renderAbout({ ...EMPTY, mission: "Line one.\nLine two." });
		const el = screen.getByText(/Line one/);
		expect(el.className).toContain("whitespace-pre-line");
		expect(el.textContent).toBe("Line one.\nLine two.");
	});

	it("names the club in the heading", () => {
		renderAbout({ ...EMPTY, meetingSchedule: "Thursdays" });
		expect(screen.getByText(/About Harbor City Speakers/)).toBeTruthy();
	});
});

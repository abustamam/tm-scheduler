// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClubRoleSheet, type RoleSheetEntry } from "./club-role-sheet";

afterEach(cleanup);

const roles: RoleSheetEntry[] = [
	{
		id: "1",
		name: "Toastmaster",
		category: "leadership",
		description: "Hosts the meeting and introduces each segment.",
	},
	{
		id: "2",
		name: "Timer",
		category: "functionary",
		description: "Tracks each segment's time and shows the signals.",
	},
	{
		id: "3",
		name: "Grammarian",
		category: "functionary",
		description: null,
	},
	{
		id: "4",
		name: "Speaker",
		category: "speaker",
		description: "Delivers a prepared speech from a Pathways project.",
	},
];

describe("ClubRoleSheet", () => {
	it("renders each role name and its description", () => {
		render(
			<ClubRoleSheet
				clubName="Downtown Toastmasters"
				clubNumber="1234"
				roles={roles}
			/>,
		);
		expect(screen.getByText("Toastmaster")).toBeTruthy();
		expect(
			screen.getByText("Hosts the meeting and introduces each segment."),
		).toBeTruthy();
		// A role without a description still renders its name.
		expect(screen.getByText("Grammarian")).toBeTruthy();
	});

	it("groups roles by category and skips empty categories", () => {
		render(
			<ClubRoleSheet
				clubName="Downtown Toastmasters"
				clubNumber="1234"
				roles={roles}
			/>,
		);
		expect(screen.getByText("Leadership")).toBeTruthy();
		expect(screen.getByText("Functionary Roles")).toBeTruthy();
		expect(screen.getByText("Speaking Roles")).toBeTruthy();
		// No evaluator roles in the fixture → the "Evaluation" heading is absent.
		expect(screen.queryByText("Evaluation")).toBeNull();
	});

	it("shows the club name, number, and the non-affiliation disclaimer", () => {
		render(
			<ClubRoleSheet
				clubName="Downtown Toastmasters"
				clubNumber="1234"
				roles={roles}
			/>,
		);
		// Club name appears in both the header band and the footer.
		expect(screen.getAllByText("Downtown Toastmasters").length).toBeGreaterThan(
			0,
		);
		expect(screen.getByText(/Club #1234/)).toBeTruthy();
		expect(
			screen.getByText(/not affiliated with, endorsed by, or sponsored by/),
		).toBeTruthy();
	});

	it("renders a helpful message when the club has no roles", () => {
		render(
			<ClubRoleSheet clubName="Empty Club" clubNumber={null} roles={[]} />,
		);
		expect(
			screen.getByText(/No roles have been configured for this club/),
		).toBeTruthy();
	});
});

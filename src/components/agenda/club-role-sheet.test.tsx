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

describe("club logo (#496)", () => {
	const LOGO =
		"/api/club/11111111-1111-4111-8111-111111111111/logo?v=1754000000000";

	it("renders the club's logo in the header band when one is set", () => {
		render(
			<ClubRoleSheet
				clubName="Downtown Toastmasters"
				clubNumber="1234567"
				roles={roles}
				logoUrl={LOGO}
			/>,
		);
		const img = document.querySelector<HTMLImageElement>(`img[src="${LOGO}"]`);
		expect(img).not.toBeNull();
		expect(img?.style.height).toBe("40px");
		expect(img?.getAttribute("alt")).toBe("");
	});

	it("renders no image element at all when the club has no logo", () => {
		render(
			<ClubRoleSheet
				clubName="Downtown Toastmasters"
				clubNumber="1234567"
				roles={roles}
				logoUrl={null}
			/>,
		);
		expect(document.querySelector("img")).toBeNull();
	});

	// NOT getByText("Downtown Toastmasters"): this sheet prints the club name
	// TWICE — once in the header band and again in the DarkFooter — so matching
	// by owner alone is ambiguous AND cannot tell the two apart. Assert the
	// header ROW instead: the logo and the name must sit in the same container,
	// which is the thing this layout change actually claims.
	it("puts the logo and the club name in the same header row", () => {
		render(
			<ClubRoleSheet
				clubName="Downtown Toastmasters"
				clubNumber="1234567"
				roles={roles}
				logoUrl={LOGO}
			/>,
		);
		const img = document.querySelector<HTMLImageElement>(`img[src="${LOGO}"]`);
		// The image's immediate parent is the light plate `ClubLogo` renders
		// behind it (a dark logo on this dark header band would otherwise be
		// invisible); the header row is one level above that.
		const plate = img?.parentElement;
		// jsdom normalizes #fff to its rgb() form.
		expect(plate?.style.background).toBe("rgb(255, 255, 255)");
		const headerRow = plate?.parentElement;
		expect(headerRow).not.toBeNull();
		expect(headerRow?.textContent).toContain("Downtown Toastmasters");
		expect(headerRow?.textContent).toContain("Club #1234567");
		// And the footer copy is a genuinely separate element, not this one.
		expect(screen.getAllByText("Downtown Toastmasters").length).toBe(2);
	});
});

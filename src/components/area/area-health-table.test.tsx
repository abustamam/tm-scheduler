// @vitest-environment jsdom
//
// The Area Director's view (#1119): the desktop table, the phone cards and the
// page around them. The values are stubbed `ClubHealth` rows, because what is
// under test is what each kind of row PRINTS: a club on GavelUp with every
// number, a field the club does not record ("Not tracked", never "0"), and a
// club that is not on GavelUp (a name and a sentence).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AreaClubCard } from "#/components/area/area-club-card";
import { AreaHealthTable } from "#/components/area/area-health-table";
import {
	formatAsOf,
	NOT_TRACKED_TEXT,
} from "#/components/area/area-health-values";
import { AreaHealthView } from "#/components/area/area-health-view";
import type { AreaHealth, ClubHealth } from "#/lib/area-health";
import { AREA_HEALTH_FIELDS } from "#/lib/area-health-fields";

// The visit cell's controls call these and reload the router; neither is under
// test here (`area-visits-cell.test.tsx` covers them).
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useRouter: () => ({ invalidate: vi.fn() }),
}));
vi.mock("#/server/area-visits", () => ({
	recordClubVisit: vi.fn(),
	clearClubVisit: vi.fn(),
}));

afterEach(cleanup);

const UNTRACKED = {
	meetings: { tracked: false },
	roleFillRate: { tracked: false },
	attendance: { tracked: false },
	officers: { tracked: false },
	dcp: { tracked: false },
	renewals: { tracked: false },
} as const;

/** A club on GavelUp that records everything. */
function tracked(overrides: Partial<ClubHealth> = {}): ClubHealth {
	return {
		areaClubId: "row-1",
		name: "Downtown Speakers",
		clubNumber: "1234567",
		status: "on_gavelup",
		meetings: {
			tracked: true,
			value: {
				held: 5,
				cancelled: 1,
				daysSinceLast: 9,
				next: ["2026-10-15T12:00:00.000Z", "2026-10-22T12:00:00.000Z"],
			},
		},
		roleFillRate: { tracked: true, value: { filled: 18, total: 24 } },
		attendance: {
			tracked: true,
			value: { avgMembers: 11.25, avgGuests: 0.5, rollTaken: 4, held: 5 },
		},
		officers: {
			tracked: true,
			value: {
				seatsFilled: 6,
				seatsTotal: 7,
				trained: { tracked: true, value: 4 },
			},
		},
		dcp: { tracked: true, value: { goalsMet: 7 } },
		renewals: {
			tracked: true,
			value: { paidThisPeriod: 14, paidLastPeriod: 16 },
		},
		...overrides,
	};
}

/** A club that is not on GavelUp (never was, was deleted, or is archived, which
 *  the payload does not tell apart): no numbers at all. */
function withoutData(
	status: "not_on_gavelup",
	overrides: Partial<ClubHealth> = {},
): ClubHealth {
	return {
		areaClubId: `row-${status}`,
		name: "Uptown Orators",
		clubNumber: "7654321",
		status,
		...UNTRACKED,
		...overrides,
	};
}

function health(clubs: ClubHealth[]): AreaHealth {
	return {
		areaId: "area-1",
		label: "C3",
		programYear: 2026,
		asOf: "2026-10-09T14:32:00.000Z",
		clubs,
	};
}

describe("AreaHealthTable", () => {
	it("has one row per club and one column per field, in AREA_HEALTH_FIELDS order", () => {
		render(
			<AreaHealthTable
				areaId="area-1"
				visits={{}}
				clubs={[tracked(), withoutData("not_on_gavelup")]}
			/>,
		);
		const headers = screen
			.getAllByRole("columnheader")
			.map((h) => h.textContent);
		expect(headers).toEqual([
			"Club",
			...AREA_HEALTH_FIELDS.map((f) => f.label),
			"Visits",
		]);
		// Header row + one per club.
		expect(screen.getAllByRole("row")).toHaveLength(3);
	});

	it("prints a club on GavelUp's numbers, with its name and number", () => {
		render(<AreaHealthTable areaId="area-1" visits={{}} clubs={[tracked()]} />);
		const row = screen.getByRole("row", { name: /Downtown Speakers/ });
		const cells = within(row);
		expect(cells.getByText("Downtown Speakers")).toBeTruthy();
		expect(cells.getByText("Club 1234567")).toBeTruthy();
		expect(cells.getByText("5 held, 1 cancelled")).toBeTruthy();
		expect(cells.getByText("Last held 9 days ago")).toBeTruthy();
		expect(cells.getByText("75%")).toBeTruthy();
		expect(cells.getByText("18 of 24 roles filled")).toBeTruthy();
		expect(cells.getByText("11.3 members")).toBeTruthy();
		expect(cells.getByText("6 of 7 filled")).toBeTruthy();
		expect(cells.getByText("4 trained")).toBeTruthy();
		expect(cells.getByText("7 of 10 goals")).toBeTruthy();
		expect(cells.getByText("14 this period")).toBeTruthy();
		expect(cells.getByText("16 last period")).toBeTruthy();
		// No "Not tracked" for a club that tracks everything (control).
		expect(cells.queryByText(NOT_TRACKED_TEXT)).toBeNull();
	});

	it("prints Not tracked for a field the club does not record, never a zero", () => {
		render(
			<AreaHealthTable
				areaId="area-1"
				visits={{}}
				clubs={[
					tracked({
						attendance: { tracked: false },
						dcp: { tracked: false },
						renewals: { tracked: false },
					}),
				]}
			/>,
		);
		const row = screen.getByRole("row", { name: /Downtown Speakers/ });
		expect(within(row).getAllByText(NOT_TRACKED_TEXT)).toHaveLength(3);
		// The fields that ARE tracked still print their numbers (control), and
		// the untracked cells carry no number at all.
		expect(within(row).getByText("75%")).toBeTruthy();
		const cells = within(row).getAllByRole("cell");
		const untrackedCells = cells.filter(
			(c) => c.textContent === NOT_TRACKED_TEXT,
		);
		expect(untrackedCells).toHaveLength(3);
		for (const cell of untrackedCells) {
			expect(cell.textContent).not.toMatch(/\d/);
		}
	});

	it("says Training not tracked beside a tracked officer count, not a zero", () => {
		render(
			<AreaHealthTable
				areaId="area-1"
				visits={{}}
				clubs={[
					tracked({
						officers: {
							tracked: true,
							value: {
								seatsFilled: 3,
								seatsTotal: 7,
								trained: { tracked: false },
							},
						},
					}),
				]}
			/>,
		);
		expect(screen.getByText("3 of 7 filled")).toBeTruthy();
		expect(screen.getByText("Training: not tracked")).toBeTruthy();
		expect(screen.queryByText("0 trained")).toBeNull();
	});

	it("names a club that is not on GavelUp, with its number and a sentence, and no figures", () => {
		render(
			<AreaHealthTable
				areaId="area-1"
				visits={{}}
				clubs={[withoutData("not_on_gavelup")]}
			/>,
		);
		const row = screen.getByRole("row", { name: /Uptown Orators/ });
		expect(within(row).getByText("Uptown Orators")).toBeTruthy();
		expect(within(row).getByText("Club 7654321")).toBeTruthy();
		expect(within(row).getByText("Not on GavelUp")).toBeTruthy();
		// One cell spanning the figures, not six "Not tracked" ones, and the visits
		// cell beside it: a name-only club still has visits to record (#1120).
		const cells = within(row).getAllByRole("cell");
		expect(cells).toHaveLength(2);
		expect(cells[0]?.getAttribute("colspan")).toBe(
			String(AREA_HEALTH_FIELDS.length),
		);
		expect(within(row).getAllByText(/^Round \d:/)).toHaveLength(2);
		expect(within(row).queryByText(NOT_TRACKED_TEXT)).toBeNull();
	});

	it("omits the club number line for a club with none on file", () => {
		render(
			<AreaHealthTable
				areaId="area-1"
				visits={{}}
				clubs={[withoutData("not_on_gavelup", { clubNumber: null })]}
			/>,
		);
		expect(screen.queryByText(/^Club \d/)).toBeNull();
		expect(screen.getByText("Not on GavelUp")).toBeTruthy();
	});

	it("says there are no meetings on the calendar rather than printing an empty list", () => {
		render(
			<AreaHealthTable
				areaId="area-1"
				visits={{}}
				clubs={[
					tracked({
						meetings: {
							tracked: true,
							value: { held: 0, cancelled: 0, daysSinceLast: null, next: [] },
						},
					}),
				]}
			/>,
		);
		expect(screen.getByText("0 held")).toBeTruthy();
		expect(screen.getByText("None held yet")).toBeTruthy();
		expect(screen.getByText("No meetings on the calendar")).toBeTruthy();
	});

	it("lists the next meeting dates after mount", () => {
		render(<AreaHealthTable areaId="area-1" visits={{}} clubs={[tracked()]} />);
		// Noon UTC is the same calendar day in every zone from UTC-11 to UTC+11.
		expect(screen.getByText(/^Next: .*Oct 15.*Oct 22/)).toBeTruthy();
	});
});

describe("visits in the table and the card (#1120)", () => {
	it("shows each club's visit dates in its row, from the visits map", () => {
		render(
			<AreaHealthTable
				areaId="area-1"
				visits={{ "row-1": { 1: "2026-10-12" } }}
				clubs={[tracked()]}
			/>,
		);
		const row = screen.getByRole("row", { name: /Downtown Speakers/ });
		expect(within(row).getByText("Oct 12")).toBeTruthy();
		expect(within(row).getByText("not yet")).toBeTruthy();
		expect(
			within(row).getByRole("button", { name: "Edit round 1 visit" }),
		).toBeTruthy();
	});

	it("links each club's one-page summary, and hides the link and the controls when readOnly", () => {
		const { unmount } = render(
			<AreaHealthTable areaId="area-1" visits={{}} clubs={[tracked()]} />,
		);
		expect(
			screen.getByRole("link", { name: "Print summary" }).getAttribute("href"),
		).toBe("/area/area-1/club/row-1/print");
		unmount();

		render(
			<AreaHealthTable
				areaId="area-1"
				visits={{}}
				clubs={[tracked()]}
				readOnly
			/>,
		);
		expect(screen.queryByRole("link", { name: "Print summary" })).toBeNull();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});

	it("shows the card's visits and print link, and drops both controls when readOnly", () => {
		const { unmount } = render(
			<AreaClubCard
				areaId="area-1"
				visits={{ "row-1": { 2: "2027-01-20" } }}
				club={tracked()}
			/>,
		);
		expect(screen.getByText("Jan 20")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Print summary" }).getAttribute("href"),
		).toBe("/area/area-1/club/row-1/print");
		expect(
			screen.getByRole("button", { name: "Record round 1 visit" }),
		).toBeTruthy();
		unmount();

		render(
			<AreaClubCard
				areaId="area-1"
				visits={{ "row-1": { 2: "2027-01-20" } }}
				club={tracked()}
				readOnly
			/>,
		);
		expect(screen.getByText("Jan 20")).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Print summary" })).toBeNull();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});
});

describe("AreaClubCard", () => {
	it("prints every field under its label for a club on GavelUp", () => {
		render(<AreaClubCard areaId="area-1" visits={{}} club={tracked()} />);
		expect(
			screen.getByRole("heading", { name: "Downtown Speakers" }),
		).toBeTruthy();
		expect(screen.getByText("Club 1234567")).toBeTruthy();
		for (const field of AREA_HEALTH_FIELDS) {
			expect(screen.getByText(field.label)).toBeTruthy();
		}
		expect(screen.getByText("75%")).toBeTruthy();
		expect(screen.getByText("7 of 10 goals")).toBeTruthy();
	});

	it("prints Not tracked for an untracked field, never a zero", () => {
		render(
			<AreaClubCard
				areaId="area-1"
				visits={{}}
				club={tracked({
					roleFillRate: { tracked: false },
					dcp: { tracked: false },
				})}
			/>,
		);
		expect(screen.getAllByText(NOT_TRACKED_TEXT)).toHaveLength(2);
		expect(screen.queryByText("0%")).toBeNull();
		expect(screen.queryByText("0 of 10 goals")).toBeNull();
	});

	it("says Not on GavelUp and carries no figures", () => {
		render(
			<AreaClubCard
				areaId="area-1"
				visits={{}}
				club={withoutData("not_on_gavelup")}
			/>,
		);
		expect(screen.getByText("Not on GavelUp")).toBeTruthy();
		expect(screen.getByText("Club 7654321")).toBeTruthy();
		expect(screen.queryByText("Meetings")).toBeNull();
	});
});

describe("AreaHealthView", () => {
	it("names when the numbers were read, in UTC, and what the counts cover", () => {
		render(<AreaHealthView health={health([tracked()])} visits={{}} />);
		expect(screen.getByText(/As of Oct 9, 2026, 2:32 PM UTC\./)).toBeTruthy();
		expect(screen.getByText(/the last 90 days/)).toBeTruthy();
	});

	it("renders both layouts, so a phone and a desktop each have one", () => {
		render(<AreaHealthView health={health([tracked()])} visits={{}} />);
		expect(screen.getByRole("table")).toBeTruthy();
		expect(screen.getAllByRole("article")).toHaveLength(1);
	});

	it("says so when the area has no clubs", () => {
		render(<AreaHealthView health={health([])} visits={{}} />);
		expect(
			screen.getByText("There are no clubs in this area yet."),
		).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
	});
});

describe("formatAsOf", () => {
	it("is the same string whatever zone the runtime is in", () => {
		expect(formatAsOf("2026-10-09T14:32:00.000Z")).toBe(
			"Oct 9, 2026, 2:32 PM UTC",
		);
		// An instant that is the next day in Tokyo and the previous in Honolulu.
		expect(formatAsOf("2026-10-09T23:30:00.000Z")).toBe(
			"Oct 9, 2026, 11:30 PM UTC",
		);
	});
});

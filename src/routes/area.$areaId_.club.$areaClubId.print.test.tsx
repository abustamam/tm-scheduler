// @vitest-environment jsdom
//
// The club visit summary page (#1120): what its route does with a signed-out
// visitor and with the guard's refusal, and what the sheet prints. The refusal
// itself, and the cross-area pairing, are proven at the real handler in
// `src/server/area-visits.integration.test.ts`.
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_PERMISSION_MESSAGE } from "#/lib/permission-message";

const { getAreaClubSummary, getAuthContext } = vi.hoisted(() => ({
	getAreaClubSummary: vi.fn(),
	getAuthContext: vi.fn(),
}));
vi.mock("#/server/area-visits", () => ({ getAreaClubSummary }));
vi.mock("#/server/auth-context", () => ({ getAuthContext }));

import { AreaClubSummarySheet } from "#/components/area/area-club-summary-sheet";
import type { ClubHealth } from "#/lib/area-health";
import { AREA_HEALTH_FIELDS } from "#/lib/area-health-fields";
import { Route } from "./area.$areaId_.club.$areaClubId.print";

const AREA_ID = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";
const CLUB_ID = "9d2c4a70-1b3e-4f58-8a6d-0e7f1c2b3a49";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

type BeforeLoad = (args: { location: { href: string } }) => Promise<unknown>;
type Loader = (args: {
	params: { areaId: string; areaClubId: string };
}) => Promise<unknown>;
const beforeLoad = Route.options.beforeLoad as BeforeLoad;
const loader = Route.options.loader as Loader;

async function rejection(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (err) {
		return err;
	}
	throw new Error("it resolved; it was expected to reject");
}

describe("the summary route (#1120)", () => {
	it("sends a signed-out visitor to /signin and back to this page", async () => {
		getAuthContext.mockResolvedValueOnce({ user: null });

		const err = await rejection(() =>
			beforeLoad({
				location: { href: `/area/${AREA_ID}/club/${CLUB_ID}/print` },
			}),
		);

		expect(isRedirect(err)).toBe(true);
		const options = (err as { options: { to: string; search: unknown } })
			.options;
		expect(options.to).toBe("/signin");
		expect(options.search).toEqual({
			redirect: `/area/${AREA_ID}/club/${CLUB_ID}/print`,
		});
	});

	it("lets a signed-in visitor through to the loader (control)", async () => {
		getAuthContext.mockResolvedValueOnce({ user: { id: "u1" } });
		await expect(
			beforeLoad({ location: { href: "/x" } }),
		).resolves.toBeUndefined();
	});

	it("asks for the area and the club in the URL", async () => {
		const summary = { areaId: AREA_ID };
		getAreaClubSummary.mockResolvedValueOnce(summary);

		await expect(
			loader({ params: { areaId: AREA_ID, areaClubId: CLUB_ID } }),
		).resolves.toBe(summary);
		expect(getAreaClubSummary).toHaveBeenCalledWith({
			data: { areaId: AREA_ID, areaClubId: CLUB_ID },
		});
	});

	it("turns the guard's refusal (a non-director, or another area's club) into not-found", async () => {
		getAreaClubSummary.mockRejectedValueOnce(new Error(NO_PERMISSION_MESSAGE));

		const err = await rejection(() =>
			loader({ params: { areaId: AREA_ID, areaClubId: CLUB_ID } }),
		);

		expect(isNotFound(err)).toBe(true);
	});

	it("does NOT turn a real failure into a 404", async () => {
		const failure = new Error("connection refused");
		getAreaClubSummary.mockRejectedValueOnce(failure);

		const err = await rejection(() =>
			loader({ params: { areaId: AREA_ID, areaClubId: CLUB_ID } }),
		);

		expect(err).toBe(failure);
	});
});

function club(overrides: Partial<ClubHealth> = {}): ClubHealth {
	return {
		areaClubId: CLUB_ID,
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

const SUMMARY = {
	label: "C3",
	programYear: 2026,
	asOf: "2026-10-09T14:32:00.000Z",
};

describe("the summary sheet (#1120)", () => {
	it("names the club, the area and when the numbers were read", () => {
		render(
			<AreaClubSummarySheet
				summary={{ ...SUMMARY, club: club(), visits: {} }}
			/>,
		);
		expect(screen.getByText("Downtown Speakers")).toBeTruthy();
		expect(screen.getByText(/Club 1234567/)).toBeTruthy();
		expect(screen.getByText(/Area C3/)).toBeTruthy();
		expect(screen.getByText(/As of Oct 9, 2026, 2:32 PM UTC/)).toBeTruthy();
	});

	it("prints the six numbers as the area view prints them, and the next meetings", () => {
		render(
			<AreaClubSummarySheet
				summary={{ ...SUMMARY, club: club(), visits: {} }}
			/>,
		);
		for (const field of AREA_HEALTH_FIELDS) {
			expect(screen.getByText(field.label)).toBeTruthy();
		}
		for (const text of [
			"5 held, 1 cancelled",
			"Last held 9 days ago",
			"75%",
			"18 of 24 roles filled",
			"11.3 members",
			"6 of 7 filled",
			"4 trained",
			"7 of 10 goals",
			"14 this period",
			"16 last period",
		]) {
			expect(screen.getByText(text)).toBeTruthy();
		}
		// The next two meetings, named after mount (`FieldValue`'s own rule).
		expect(screen.getByText(/^Next: .*Oct 15.*Oct 22/)).toBeTruthy();
	});

	it("prints both visit dates, and 'not yet' for a round with none", () => {
		const { unmount } = render(
			<AreaClubSummarySheet
				summary={{
					...SUMMARY,
					club: club(),
					visits: { 1: "2026-10-12", 2: "2027-01-20" },
				}}
			/>,
		);
		expect(screen.getByText("Oct 12")).toBeTruthy();
		expect(screen.getByText("Jan 20")).toBeTruthy();
		unmount();

		render(
			<AreaClubSummarySheet
				summary={{ ...SUMMARY, club: club(), visits: { 1: "2026-10-12" } }}
			/>,
		);
		const round2 = screen.getByText(/^Round 2:/);
		expect(within(round2).getByText("not yet")).toBeTruthy();
	});

	it("says 'Not on GavelUp' in place of the numbers for a name-only club, and still shows its visits", () => {
		render(
			<AreaClubSummarySheet
				summary={{
					...SUMMARY,
					club: club({
						status: "not_on_gavelup",
						meetings: { tracked: false },
						roleFillRate: { tracked: false },
						attendance: { tracked: false },
						officers: { tracked: false },
						dcp: { tracked: false },
						renewals: { tracked: false },
					}),
					visits: { 1: "2026-10-12" },
				}}
			/>,
		);
		expect(screen.getByText("Not on GavelUp")).toBeTruthy();
		expect(screen.queryByText("Role fill rate")).toBeNull();
		expect(screen.getByText("Oct 12")).toBeTruthy();
	});
});

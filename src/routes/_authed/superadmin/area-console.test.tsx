// @vitest-environment jsdom
//
// The superadmin console's area page (#1116). It renders the real route
// component with its server fns mocked and the loader data stubbed, and checks
// the three things an operator reads off it:
//   - a club on GavelUp is a link to its console page, and a club with a
//     recorded visit cannot be removed (the button says so);
//   - a name-only club whose number matches a GavelUp club is offered "Link
//     to <club>", and the offer calls `linkAreaClub` for that row;
//   - the current Area Director is shown with the name typed at assignment,
//     and "End term" ends THAT term, while a term left open by a past year is
//     shown as ended with that year and offers nothing to end.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const fns = vi.hoisted(() => ({
	addAreaClub: vi.fn(),
	assignAreaDirector: vi.fn(),
	endAreaDirectorTerm: vi.fn(),
	findUserForDirector: vi.fn(),
	getConsoleArea: vi.fn(),
	linkAreaClub: vi.fn(),
	removeAreaClub: vi.fn(),
	renameArea: vi.fn(),
	renameDivision: vi.fn(),
}));

vi.mock("#/server/areas", () => fns);
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import type { ConsoleAreaDetail } from "#/server/areas-logic";
import { Route } from "./areas.$areaId";

const AREA_ID = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";
const LINKED_ROW = "11111111-1111-4111-8111-111111111111";
const VISITED_ROW = "22222222-2222-4222-8222-222222222222";
const NAME_ONLY_ROW = "33333333-3333-4333-8333-333333333333";
const GAVELUP_CLUB = "44444444-4444-4444-8444-444444444444";
const OFFERED_CLUB = "55555555-5555-4555-8555-555555555555";
const TERM_ID = "66666666-6666-4666-8666-666666666666";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

function area(overrides: Partial<ConsoleAreaDetail> = {}): ConsoleAreaDetail {
	return {
		id: AREA_ID,
		label: "C3",
		number: "3",
		divisionId: "77777777-7777-4777-8777-777777777777",
		divisionLetter: "C",
		programYear: 2026,
		programYearLabel: "2026–27",
		currentProgramYear: 2026,
		districtId: "88888888-8888-4888-8888-888888888888",
		districtNumber: "39",
		clubs: [],
		availableClubs: [],
		director: null,
		pastTerms: [],
		...overrides,
	};
}

async function renderArea(detail: ConsoleAreaDetail) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue(
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		detail as any,
	);
	vi.spyOn(Route, "useParams").mockReturnValue({
		areaId: AREA_ID,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Page = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Page />);
}

describe("Area page clubs (#1116)", () => {
	it("links a GavelUp club to its console page, and will not remove one with a visit", async () => {
		await renderArea(
			area({
				clubs: [
					{
						id: LINKED_ROW,
						clubId: GAVELUP_CLUB,
						name: "Downtown Speakers",
						clubNumber: "1234567",
						visitCount: 0,
						linkOffer: null,
					},
					{
						id: VISITED_ROW,
						clubId: null,
						name: "Closed Club",
						clubNumber: null,
						visitCount: 2,
						linkOffer: null,
					},
				],
			}),
		);

		const link = screen.getByRole("link", { name: "Downtown Speakers" });
		expect(link.getAttribute("href")).toContain(GAVELUP_CLUB);
		expect(screen.getByText("Not on GavelUp")).toBeTruthy();
		expect(screen.getByText(/2 visits recorded/)).toBeTruthy();

		const remove = screen.getAllByRole("button", { name: /remove/i });
		expect(remove).toHaveLength(2);
		expect((remove[0] as HTMLButtonElement).disabled).toBe(false);
		const visited = remove[1] as HTMLButtonElement;
		expect(visited.disabled).toBe(true);
		expect(visited.title).toBe("This club has recorded visits");

		fns.removeAreaClub.mockResolvedValueOnce(undefined);
		fireEvent.click(remove[0] as HTMLButtonElement);
		await waitFor(() =>
			expect(fns.removeAreaClub).toHaveBeenCalledWith({
				data: { areaClubId: LINKED_ROW },
			}),
		);
	});

	it("offers to link a name-only club to the GavelUp club with its number", async () => {
		fns.linkAreaClub.mockResolvedValueOnce(undefined);
		await renderArea(
			area({
				clubs: [
					{
						id: NAME_ONLY_ROW,
						clubId: null,
						name: "Typed By Hand",
						clubNumber: "7654321",
						visitCount: 0,
						linkOffer: { clubId: OFFERED_CLUB, name: "Uptown Orators" },
					},
				],
			}),
		);

		expect(screen.getByText("Not on GavelUp")).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: /link to uptown orators/i }),
		);
		await waitFor(() =>
			expect(fns.linkAreaClub).toHaveBeenCalledWith({
				data: { areaClubId: NAME_ONLY_ROW },
			}),
		);
	});

	it("offers no link when no GavelUp club carries the number", async () => {
		await renderArea(
			area({
				clubs: [
					{
						id: NAME_ONLY_ROW,
						clubId: null,
						name: "Typed By Hand",
						clubNumber: "7654321",
						visitCount: 0,
						linkOffer: null,
					},
				],
			}),
		);
		expect(screen.queryByRole("button", { name: /link to/i })).toBeNull();
	});
});

describe("Area page Area Director (#1116)", () => {
	const term = {
		id: TERM_ID,
		userId: "u-1",
		displayName: "Jamie Rivera",
		email: "jamie@example.com",
		startedAt: new Date("2026-08-01T12:00:00Z"),
		endedAt: null,
	};

	it("shows the current director by the typed name, and End term ends that term", async () => {
		fns.endAreaDirectorTerm.mockResolvedValueOnce(undefined);
		await renderArea(area({ director: { ...term, state: "current" } }));

		expect(screen.getByText("Jamie Rivera")).toBeTruthy();
		expect(screen.getByText(/jamie@example\.com/)).toBeTruthy();
		// One open term per area: nothing to assign while one is open.
		expect(screen.queryByLabelText(/find the area director/i)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "End term" }));
		await waitFor(() =>
			expect(fns.endAreaDirectorTerm).toHaveBeenCalledWith({
				data: { termId: TERM_ID },
			}),
		);
	});

	it("shows a past year's open term as ended with that year, with nothing to end", async () => {
		await renderArea(
			area({
				programYear: 2025,
				programYearLabel: "2025–26",
				director: { ...term, state: "ended-with-year" },
			}),
		);

		expect(screen.getByText(/ended with 2025–26/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "End term" })).toBeNull();
		// A past year is history: no assignment form either.
		expect(screen.queryByLabelText(/find the area director/i)).toBeNull();
	});

	it("asks for a name when assigning, and sends the account the lookup found", async () => {
		fns.findUserForDirector.mockResolvedValueOnce({
			id: "user-9",
			email: "pat@example.com",
		});
		fns.assignAreaDirector.mockResolvedValueOnce({ id: TERM_ID });
		await renderArea(area());

		fireEvent.change(screen.getByLabelText(/find the area director/i), {
			target: { value: "pat@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: /find/i }));
		fireEvent.change(
			await screen.findByLabelText(/name shown to the club's admins/i),
			{ target: { value: "Pat Lee" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Make Area Director" }));

		await waitFor(() =>
			expect(fns.assignAreaDirector).toHaveBeenCalledWith({
				data: { areaId: AREA_ID, userId: "user-9", displayName: "Pat Lee" },
			}),
		);
	});

	it("says so when no verified account has the email, and offers no assignment", async () => {
		fns.findUserForDirector.mockResolvedValueOnce(null);
		await renderArea(area());

		fireEvent.change(screen.getByLabelText(/find the area director/i), {
			target: { value: "nobody@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: /find/i }));
		expect(
			await screen.findByText(/no account with that exact, verified email/i),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Make Area Director" }),
		).toBeNull();
	});
});

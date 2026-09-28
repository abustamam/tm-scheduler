// @vitest-environment jsdom
//
// The superadmin console's charter controls (#944): the create form asks for a
// club number only for a chartered club and sends the chosen status, and the
// club page offers "Move back to chartering" — the superadmin-only correction —
// for a chartered club alone.
import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const { provisionClub, revertConsoleClubToChartering } = vi.hoisted(() => ({
	provisionClub: vi.fn(),
	revertConsoleClubToChartering: vi.fn(),
}));

vi.mock("#/server/onboarding", () => ({
	archiveConsoleClub: vi.fn(),
	unarchiveConsoleClub: vi.fn(),
	getConsoleClubDetail: vi.fn(),
	updateConsoleAdminEmail: vi.fn(),
	deleteConsoleClub: vi.fn(),
	listConsoleClubs: vi.fn(),
	provisionClub,
	revertConsoleClubToChartering,
}));
vi.mock("#/server/impersonation", () => ({ startImpersonation: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { Route as ClubRoute } from "./$clubId";
import { Route as ConsoleRoute } from "./index";

const CLUB_ID = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

async function renderConsole(
	clubs: Array<Record<string, unknown>> = [],
): Promise<void> {
	vi.spyOn(ConsoleRoute, "useLoaderData").mockReturnValue({
		clubs,
		zones: ["America/Chicago", "UTC"],
		defaultZone: "America/Chicago",
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Page = ConsoleRoute.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Page />);
}

async function renderClub(
	charter: { charterStatus: string; charteredAt: string | null } | object,
) {
	vi.spyOn(ClubRoute, "useLoaderData").mockReturnValue({
		name: "Downtown Speakers",
		clubNumber: "123",
		slug: "downtown",
		memberCount: 2,
		createdAt: new Date("2026-01-01"),
		archivedAt: null,
		firstAdmin: null,
		...charter,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(ClubRoute, "useParams").mockReturnValue({
		clubId: CLUB_ID,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Page = ClubRoute.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Page />);
}

describe("create a club — charter status", () => {
	it("requires a number for a chartered club and not for a chartering one", async () => {
		await renderConsole();
		const number = screen.getByLabelText(/^Club number/) as HTMLInputElement;
		expect(number.required).toBe(true);
		expect(screen.getByLabelText("Charter date (optional)")).toBeTruthy();

		fireEvent.click(screen.getByLabelText("Chartering"));
		expect(number.required).toBe(false);
		expect(screen.getByText("Club number (optional)")).toBeTruthy();
		expect(screen.queryByLabelText("Charter date (optional)")).toBeNull();
	});

	it("sends a chartering club with no number and no date", async () => {
		provisionClub.mockResolvedValue({ slug: "new-club" });
		await renderConsole();
		fireEvent.click(screen.getByLabelText("Chartering"));
		fireEvent.change(screen.getByLabelText("Club name"), {
			target: { value: "New Club" },
		});
		fireEvent.change(screen.getByLabelText("First admin name"), {
			target: { value: "Ana" },
		});
		fireEvent.change(screen.getByLabelText("First admin email"), {
			target: { value: "ana@example.com" },
		});
		fireEvent.submit(
			screen
				.getByRole("button", { name: /Create club/ })
				.closest("form") as HTMLFormElement,
		);
		await waitFor(() => expect(provisionClub).toHaveBeenCalledTimes(1));
		expect(provisionClub.mock.calls[0][0].data).toMatchObject({
			clubName: "New Club",
			charterStatus: "chartering",
			clubNumber: "",
			charteredAt: null,
		});
	});

	it("marks a chartering club in the list", async () => {
		await renderConsole([
			{
				clubId: CLUB_ID,
				name: "Forming Club",
				clubNumber: null,
				charterStatus: "chartering",
				timezone: "UTC",
				memberCount: 1,
				createdAt: new Date("2026-01-01"),
				archivedAt: null,
				firstAdmin: null,
			},
		]);
		const row = screen.getByText("Forming Club").closest("tr") as HTMLElement;
		expect(within(row).getByText("Chartering")).toBeTruthy();
		expect(within(row).getByText("—")).toBeTruthy();
	});
});

describe("club page — charter panel", () => {
	it("offers Move back to chartering for a chartered club, and calls the superadmin fn", async () => {
		revertConsoleClubToChartering.mockResolvedValue({ ok: true });
		vi.spyOn(window, "confirm").mockReturnValue(true);
		await renderClub({ charterStatus: "chartered", charteredAt: "2026-09-01" });
		expect(screen.getByTestId("charter-summary").textContent).toContain(
			"chartered Sep 1, 2026",
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Move back to chartering/ }),
		);
		await waitFor(() =>
			expect(revertConsoleClubToChartering).toHaveBeenCalledWith({
				data: CLUB_ID,
			}),
		);
	});

	it("says when a chartered club's date was never recorded", async () => {
		await renderClub({ charterStatus: "chartered", charteredAt: null });
		expect(screen.getByTestId("charter-summary").textContent).toContain(
			"charter date not recorded",
		);
	});

	it("offers no revert for a chartering club", async () => {
		await renderClub({ charterStatus: "chartering", charteredAt: null });
		expect(screen.getByTestId("charter-summary").textContent).toContain(
			"Chartering",
		);
		expect(
			screen.queryByRole("button", { name: /Move back to chartering/ }),
		).toBeNull();
	});
});

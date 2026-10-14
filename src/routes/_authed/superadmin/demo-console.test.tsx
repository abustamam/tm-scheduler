// @vitest-environment jsdom
//
// The superadmin console's demo club card (#1199): its three states, the
// confirm before a rebuild, the club count that leaves the demo club out, and
// the "Demo" badge on its row.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const { resetDemoClubFromConsole } = vi.hoisted(() => ({
	resetDemoClubFromConsole: vi.fn(),
}));

vi.mock("#/server/onboarding", () => ({
	listConsoleClubs: vi.fn(),
	getDemoClubConsole: vi.fn(),
	provisionClub: vi.fn(),
	resetDemoClubFromConsole,
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { Route as ConsoleRoute } from "./index";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const club = (over: Record<string, unknown>) => ({
	clubId: crypto.randomUUID(),
	name: "A Club",
	clubNumber: "111",
	charterStatus: "chartered",
	timezone: "UTC",
	memberCount: 3,
	createdAt: new Date("2026-01-01"),
	archivedAt: null,
	isDemo: false,
	firstAdmin: null,
	...over,
});

async function renderConsole(
	demo: { configured: boolean; club: { id: string; builtAt: Date } | null },
	clubs: Array<Record<string, unknown>> = [],
) {
	vi.spyOn(ConsoleRoute, "useLoaderData").mockReturnValue({
		clubs,
		zones: ["UTC"],
		defaultZone: "UTC",
		demo,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Page = ConsoleRoute.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Page />);
}

const button = () =>
	screen.getByRole("button", { name: /build demo club|rebuild demo club/i });

// protects=the card tells a superadmin which of three states the demo club is in
//   and only offers the action when it can work: no env var disables the button
//   and says which one; built shows when it was built;
// fails_when=the button is enabled without DEMO_ACCOUNT_EMAIL, the missing-var
//   text is absent, or a built club still reads "Build";
// no_claim=the loader's data is stubbed; the server fns are covered by the
//   integration suites.
describe("the demo club card (#1199)", () => {
	it("is disabled and names the env var when it is not configured", async () => {
		await renderConsole({ configured: false, club: null });

		expect(
			screen.getByText("Not configured: set DEMO_ACCOUNT_EMAIL"),
		).toBeTruthy();
		expect((button() as HTMLButtonElement).disabled).toBe(true);
		expect(button().textContent).toBe("Build demo club");
	});

	it("offers Build when configured and not built, with no confirm", async () => {
		const confirm = vi.spyOn(window, "confirm");
		resetDemoClubFromConsole.mockResolvedValue({ clubId: "x" });
		await renderConsole({ configured: true, club: null });

		expect((button() as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(button());

		await waitFor(() =>
			expect(resetDemoClubFromConsole).toHaveBeenCalledTimes(1),
		);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("offers Rebuild with the built date, and confirms before deleting", async () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		await renderConsole({
			configured: true,
			club: { id: "c1", builtAt: new Date("2026-10-12T12:00:00Z") },
		});

		expect(button().textContent).toBe("Rebuild demo club (built Oct 12, 2026)");
		fireEvent.click(button());

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]?.[0]).toBe(
			"Rebuilding deletes everything in the demo club, including people you added by hand, and builds it fresh. Their accounts are kept. Use @example.com addresses for anyone you add during a demo.",
		);
		// Declined: nothing is sent.
		expect(resetDemoClubFromConsole).not.toHaveBeenCalled();

		confirm.mockReturnValue(true);
		resetDemoClubFromConsole.mockResolvedValue({ clubId: "x" });
		fireEvent.click(button());
		await waitFor(() =>
			expect(resetDemoClubFromConsole).toHaveBeenCalledTimes(1),
		);
	});

	// protects=the list header counts the platform's clubs and not the demo club,
	//   which is still listed, marked "Demo";
	// fails_when=the count includes the demo club, or its row carries no badge, or
	//   a real club gets one;
	// no_claim=none beyond protects.
	it("leaves the demo club out of the count and badges its row", async () => {
		await renderConsole({ configured: true, club: null }, [
			club({ name: "Real One" }),
			club({ name: "Real Two" }),
			club({ name: "GavelUp Demo Club", isDemo: true }),
		]);

		expect(screen.getByText("All clubs (2)")).toBeTruthy();
		expect(screen.getAllByText("Demo")).toHaveLength(1);
		const row = screen.getByText("GavelUp Demo Club").closest("tr");
		expect(row?.textContent).toContain("Demo");
		expect(
			screen.getByText("Real One").closest("tr")?.textContent,
		).not.toContain("Demo");
	});
});

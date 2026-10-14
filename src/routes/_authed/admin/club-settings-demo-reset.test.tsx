// @vitest-environment jsdom
//
// The demo club's "Reset demo club" card on /admin/club-settings (#1200). The
// card is display only: it renders when the loader's club row says `isDemo`, and
// the server refuses everyone else (clubs-reset-demo.integration.test.ts). Same
// stubbing as club-settings.test.tsx.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/clubs", () => ({
	getClubProfileSettings: vi.fn(),
	loadClubAgendaSettings: vi.fn(),
	loadClubTimezoneSettings: vi.fn(),
	resetDemoClubFromClub: vi.fn(),
	updateClubAgendaSettings: vi.fn(),
	updateClubProfile: vi.fn(),
	updateClubTimezone: vi.fn(),
}));
vi.mock("#/server/club-logo", () => ({
	getClubLogoMeta: vi.fn(),
	uploadClubLogo: vi.fn(),
	removeClubLogoFn: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { REBUILD_CONFIRM } from "#/lib/demo-club-copy";
import { resetDemoClubFromClub } from "#/server/clubs";
import { Route } from "./club-settings";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

function loaderData(isDemo: boolean | undefined) {
	return {
		profile: {
			name: "Club",
			district: "",
			mission: "",
			meetingSchedule: "",
			defaultCountryCode: "",
			...(isDemo === undefined ? {} : { isDemo }),
		},
		agenda: {
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
			digitalVotingEnabled: true,
			defaultPrintLayout: "grid",
		},
		logoMeta: null,
		timezone: { timezone: "America/Chicago", zones: ["America/Chicago"] },
	};
}

async function renderRoute(isDemo: boolean | undefined) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		adminClub: {
			clubId: CLUB_ID,
			name: "Club",
			clubNumber: null,
			clubRole: "admin",
		},
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	vi.spyOn(Route, "useLoaderData").mockReturnValue(loaderData(isDemo) as any);
	const Component = Route.options.component as () => React.ReactElement;
	const router = createRouter({
		routeTree: createRootRoute({ component: () => <Component /> }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	return router;
}

const resetButton = () =>
	screen.queryByRole("button", { name: "Reset demo club" });

describe("the demo club reset card (#1200)", () => {
	// protects=the card shows for the demo club and only there, with the console's
	//   warning text on it;
	// fails_when=the card renders for a real club (or one whose loader row has no
	//   `isDemo`, as an older server sends), or the demo club has none, or its
	//   warning is not the shared text;
	// no_claim=that a real club's admin cannot reset: the card is display only, the
	//   server's refusal is in clubs-reset-demo.integration.test.ts.
	it.each([
		[true, true],
		[false, false],
		[undefined, false],
	] as const)("isDemo=%s renders the card: %s", async (isDemo, shown) => {
		await renderRoute(isDemo);
		expect(resetButton() !== null).toBe(shown);
		expect(screen.queryByText(REBUILD_CONFIRM) !== null).toBe(shown);
	});

	// protects=a confirmed reset calls the server with THIS club's id, then leaves
	//   the page for `/` where the new demo club is found; a declined confirm does
	//   nothing;
	// fails_when=the call is made without the confirm, with another club's id, or
	//   the page stays on the deleted club;
	// no_claim=that `/` lands in the new club (the active-club fallback is pinned in
	//   active-club.test.ts); `resetDemoClubFromClub` is a stub.
	it("asks first, calls the server with its club, and navigates to /", async () => {
		vi.mocked(resetDemoClubFromClub).mockResolvedValue({ clubId: "new" });
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		const router = await renderRoute(true);
		const navigate = vi.spyOn(router, "navigate");

		fireEvent.click(resetButton() as HTMLElement);
		expect(confirm).toHaveBeenCalledWith(REBUILD_CONFIRM);
		expect(resetDemoClubFromClub).not.toHaveBeenCalled();

		confirm.mockReturnValue(true);
		fireEvent.click(resetButton() as HTMLElement);
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		expect(resetDemoClubFromClub).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID },
		});
		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({ to: "/", replace: true }),
		);
	});

	// protects=a refusal from the server reaches the presenter and the page stays;
	// fails_when=the error is swallowed, or the page navigates away anyway;
	// no_claim=which refusal; the message is whatever the server threw.
	it("shows the server's refusal and stays", async () => {
		vi.mocked(resetDemoClubFromClub).mockRejectedValue(
			new Error("That club is not the demo club."),
		);
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const router = await renderRoute(true);
		const navigate = vi.spyOn(router, "navigate");

		fireEvent.click(resetButton() as HTMLElement);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"That club is not the demo club.",
			),
		);
		expect(navigate).not.toHaveBeenCalled();
		expect(resetButton()).not.toBeNull();
	});
});

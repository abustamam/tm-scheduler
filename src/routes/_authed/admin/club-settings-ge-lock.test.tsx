// @vitest-environment jsdom
//
// The General Evaluator checkbox is locked while the club runs its own default
// agenda (#910, spec D5): disabled, with the explanation and a link to the
// Agendas page. The server refuses the change as well
// (`updateClubAgendaSettings` → `assertGeChangeAllowed`, integration-tested in
// `club-agendas.integration.test.ts`); this is the half a person sees.
//
// Same harness as `club-settings.test.tsx`: every server-fn import mocked, the
// route's hooks stubbed, the component rendered inside a bare router.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/clubs", () => ({
	getClubProfileSettings: vi.fn(),
	loadClubAgendaSettings: vi.fn(),
	loadClubTimezoneSettings: vi.fn(),
	updateClubAgendaSettings: vi.fn(),
	updateClubProfile: vi.fn(),
	updateClubTimezone: vi.fn(),
}));
vi.mock("#/server/notification-prefs", () => ({
	loadClubReminderSettings: vi.fn(),
	updateClubReminderSettings: vi.fn(),
}));
vi.mock("#/server/club-logo", () => ({
	getClubLogoMeta: vi.fn(),
	uploadClubLogo: vi.fn(),
	removeClubLogoFn: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GE_LOCKED_MESSAGE } from "#/lib/club-agendas-copy";
import { Route } from "./club-settings";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

function loaderData(adopted: boolean) {
	return {
		profile: {
			name: "Downtown Club",
			district: "",
			mission: "",
			meetingSchedule: "",
			defaultCountryCode: "",
		},
		reminders: { enabled: true, leadTimeDays: 3 },
		agenda: {
			geIntroducesFunctionaries: true,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
			digitalVotingEnabled: true,
			adopted,
		},
		logoMeta: null,
		timezone: { timezone: "UTC", zones: ["UTC"] },
	};
}

async function renderSettings(adopted: boolean) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		adminClub: {
			clubId: CLUB_ID,
			name: "Downtown Club",
			clubNumber: "1",
			clubRole: "admin",
		},
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue(
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		loaderData(adopted) as any,
	);
	const Component = Route.options.component as () => React.ReactElement;
	const router = createRouter({
		routeTree: createRootRoute({ component: () => <Component /> }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

function geCheckbox(): HTMLInputElement {
	return screen.getByRole("checkbox", {
		name: "General Evaluator introduces the functionaries",
	}) as HTMLInputElement;
}

describe("the General Evaluator checkbox (#910)", () => {
	it("is disabled, explained and linked to Agendas while the club has a default agenda", async () => {
		await renderSettings(true);
		expect(geCheckbox().disabled).toBe(true);
		expect(geCheckbox().checked).toBe(true);
		expect(screen.getByText(GE_LOCKED_MESSAGE, { exact: false })).toBeTruthy();
		const link = screen.getByRole("link", { name: "Go to Agendas" });
		expect(link.getAttribute("href")).toBe(`/admin/agendas?club=${CLUB_ID}`);
	});

	it("stays live with no explanation while the club runs the standard agenda", async () => {
		await renderSettings(false);
		expect(geCheckbox().disabled).toBe(false);
		expect(screen.queryByText(GE_LOCKED_MESSAGE, { exact: false })).toBeNull();
	});
});

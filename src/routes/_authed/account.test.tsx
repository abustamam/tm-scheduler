// @vitest-environment jsdom
//
// #912 moved the account-level controls — reminder emails, personal access
// tokens, connected apps — off "My roles" (`/me`) onto Account settings
// (`/account`). These tests render both routes' components with the REAL
// sections and only their server fns mocked, so each section's own visibility
// rule (tokens: server-side eligibility, #773; connected apps: everyone, #851)
// is what decides what shows, exactly as on the deployed page.
//
// Pattern follows roster.test.tsx: mock the server-fn modules (they reach
// `#/db` → `pg`, which must not load under jsdom), stub `Route.useLoaderData`,
// and render `Route.options.component` under the memory-router harness.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const { getApiTokenState, getConnectedApps } = vi.hoisted(() => ({
	getApiTokenState: vi.fn(),
	getConnectedApps: vi.fn(),
}));

vi.mock("#/server/api-tokens", () => ({
	getApiTokenState,
	generateApiToken: vi.fn(),
	revokeApiTokenFn: vi.fn(),
}));
vi.mock("#/server/oauth-grants", () => ({
	getConnectedApps,
	disconnectConnectedApp: vi.fn(),
}));
vi.mock("#/server/notification-prefs", () => ({
	getMyReminderOptOut: vi.fn(),
	setMyReminderOptOut: vi.fn(),
}));
vi.mock("#/server/meetings", () => ({
	listMyCommitments: vi.fn(),
}));
vi.mock("#/server/slots", () => ({
	releaseSlot: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { Route as AccountRoute } from "./account";
import { Route as MeRoute } from "./me";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

async function renderWithQuery(
	Component: () => React.ReactElement,
): Promise<QueryClient> {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await renderUnderMemoryRouter(
		<QueryClientProvider client={qc}>
			<Component />
		</QueryClientProvider>,
	);
	return qc;
}

async function renderAccount(opts: { eligible: boolean }) {
	getApiTokenState.mockResolvedValue({ eligible: opts.eligible, tokens: [] });
	getConnectedApps.mockResolvedValue([]);
	vi.spyOn(AccountRoute, "useLoaderData").mockReturnValue({
		reminderOptOut: false,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	return renderWithQuery(
		AccountRoute.options.component as () => React.ReactElement,
	);
}

describe("/account (#912)", () => {
	it("gives an officer Account settings with reminders, tokens and connected apps", async () => {
		await renderAccount({ eligible: true });

		expect(
			screen.getByRole("heading", { level: 1, name: "Account settings" }),
		).toBeTruthy();
		expect(screen.getByText("Reminder emails")).toBeTruthy();
		expect(await screen.findByText("Personal access tokens")).toBeTruthy();
		expect(await screen.findByText("Connected apps")).toBeTruthy();
	});

	it("gives a plain member connected apps but no tokens section", async () => {
		const qc = await renderAccount({ eligible: false });

		// Wait for the token query to SETTLE before asserting an absence, or the
		// section is "absent" only because it has not loaded yet.
		expect(await screen.findByText("Connected apps")).toBeTruthy();
		await vi.waitFor(() =>
			expect(qc.getQueryState(["api-tokens"])?.status).toBe("success"),
		);
		expect(screen.queryByText("Personal access tokens")).toBeNull();
		expect(screen.getByText("Reminder emails")).toBeTruthy();
	});
});

describe("/me after #912", () => {
	it("no longer renders the account sections, and points to /account", async () => {
		vi.spyOn(MeRoute, "useLoaderData").mockReturnValue({
			commitments: [],
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		} as any);
		vi.spyOn(MeRoute, "useRouteContext").mockReturnValue({
			currentMemberId: null,
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		} as any);
		await renderWithQuery(
			MeRoute.options.component as () => React.ReactElement,
		);

		expect(
			screen.getByRole("heading", { level: 1, name: "My roles" }),
		).toBeTruthy();
		const pointer = screen.getByRole("link", { name: "Account settings" });
		expect(pointer.getAttribute("href")).toBe("/account");
		expect(pointer.closest("p")?.textContent).toBe(
			"API tokens and connected apps have moved to Account settings.",
		);

		expect(screen.queryByText("Reminder emails")).toBeNull();
		expect(screen.queryByText("Personal access tokens")).toBeNull();
		expect(screen.queryByText("Connected apps")).toBeNull();
		// Not merely hidden: the sections are not mounted, so /me asks for
		// neither query.
		expect(getApiTokenState).not.toHaveBeenCalled();
		expect(getConnectedApps).not.toHaveBeenCalled();
	});
});

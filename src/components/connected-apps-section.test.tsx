// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getConnectedApps, disconnectConnectedApp, toastSuccess } = vi.hoisted(
	() => ({
		getConnectedApps: vi.fn(),
		disconnectConnectedApp: vi.fn(),
		toastSuccess: vi.fn(),
	}),
);
vi.mock("#/server/oauth-grants", () => ({
	getConnectedApps,
	disconnectConnectedApp,
}));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: vi.fn() },
}));

import { ConnectedAppsSection } from "./connected-apps-section";

function renderSection() {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={qc}>
			<ConnectedAppsSection />
		</QueryClientProvider>,
	);
}

const CLAUDE = {
	clientId: "client-claude",
	name: "Claude",
	approvedAt: new Date("2026-09-01T12:00:00Z"),
	lastActiveAt: new Date(Date.now() - 5 * 60 * 1000),
};
const UNNAMED = {
	clientId: "client-anon-123",
	name: null,
	approvedAt: new Date("2026-08-01T12:00:00Z"),
	lastActiveAt: null,
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ConnectedAppsSection (#851)", () => {
	it("lists each app with its name, approval and last activity", async () => {
		getConnectedApps.mockResolvedValue([CLAUDE, UNNAMED]);
		renderSection();

		const items = await screen.findAllByRole("listitem");
		expect(items).toHaveLength(2);
		const [claude, anon] = items as [HTMLElement, HTMLElement];
		expect(within(claude).getByText("Claude")).toBeTruthy();
		expect(claude.textContent).toContain(
			`Approved ${CLAUDE.approvedAt.toLocaleDateString()}`,
		);
		expect(claude.textContent).toContain("Last active 5 minutes ago");
		// No name: a stand-in plus the id, so two unnamed apps stay tellable apart.
		expect(anon.textContent).toContain("Unnamed app");
		expect(within(anon).getByText("client-anon-123").tagName).toBe("CODE");
		expect(anon.textContent).toContain("Not used yet");
	});

	it("says so when nothing is connected", async () => {
		getConnectedApps.mockResolvedValue([]);
		renderSection();
		expect(
			await screen.findByText("No apps are connected to your account."),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
	});

	it("confirms first, says access ends within an hour, then disconnects by client id", async () => {
		const user = userEvent.setup();
		getConnectedApps.mockResolvedValue([CLAUDE]);
		disconnectConnectedApp.mockResolvedValue({
			consentsDeleted: 1,
			refreshTokensRevoked: 1,
		});
		renderSection();

		await user.click(await screen.findByRole("button", { name: "Disconnect" }));
		// Opening the dialog writes nothing.
		expect(disconnectConnectedApp).not.toHaveBeenCalled();
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Disconnect Claude?")).toBeTruthy();
		expect(dialog.textContent).toContain("won't be able to renew its access");
		expect(dialog.textContent).toContain("stops working within an hour");

		getConnectedApps.mockResolvedValue([]);
		await user.click(
			within(dialog).getByRole("button", { name: "Disconnect" }),
		);
		expect(disconnectConnectedApp).toHaveBeenCalledWith({
			data: { clientId: "client-claude" },
		});
		expect(toastSuccess).toHaveBeenCalledWith("Disconnected Claude.");
		// Invalidated: the list is fetched again and comes back empty.
		expect(
			await screen.findByText("No apps are connected to your account."),
		).toBeTruthy();
	});

	it("keeping the app closes the dialog without a write", async () => {
		const user = userEvent.setup();
		getConnectedApps.mockResolvedValue([CLAUDE]);
		renderSection();
		await user.click(await screen.findByRole("button", { name: "Disconnect" }));
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Keep connected",
			}),
		);
		expect(disconnectConnectedApp).not.toHaveBeenCalled();
	});
});

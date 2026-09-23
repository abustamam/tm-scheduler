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

function renderSection(props: { hideWhenEmpty?: boolean } = {}) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={qc}>
			<ConnectedAppsSection {...props} />
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
			refreshTokensDeleted: 1,
			codesDeleted: 0,
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

	it("a failed load says so and offers Retry, never the empty state", async () => {
		const user = userEvent.setup();
		getConnectedApps.mockRejectedValueOnce(new Error("network down"));
		renderSection();
		expect(
			await screen.findByText("Couldn't load your connected apps."),
		).toBeTruthy();
		expect(
			screen.queryByText("No apps are connected to your account."),
		).toBeNull();

		getConnectedApps.mockResolvedValue([CLAUDE]);
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(
			await screen.findByRole("button", { name: "Disconnect" }),
		).toBeTruthy();
	});

	it("labels an app that still has access with no approval on file", async () => {
		getConnectedApps.mockResolvedValue([{ ...CLAUDE, approvedAt: null }]);
		renderSection();
		const [row] = await screen.findAllByRole("listitem");
		expect(row?.textContent).toContain("Still has access, approval removed");
	});

	describe("hideWhenEmpty (the no-club screen)", () => {
		it("renders nothing when the person holds no grant", async () => {
			getConnectedApps.mockResolvedValue([]);
			const { container } = renderSection({ hideWhenEmpty: true });
			await vi.waitFor(() => expect(getConnectedApps).toHaveBeenCalledTimes(1));
			await new Promise((r) => setTimeout(r, 0));
			expect(container.textContent).toBe("");
		});

		it("renders the section when the person holds one", async () => {
			getConnectedApps.mockResolvedValue([CLAUDE]);
			renderSection({ hideWhenEmpty: true });
			expect(
				await screen.findByRole("button", { name: "Disconnect" }),
			).toBeTruthy();
		});

		it("still renders a failed load, so a grant is never hidden by an error", async () => {
			getConnectedApps.mockRejectedValueOnce(new Error("network down"));
			renderSection({ hideWhenEmpty: true });
			expect(
				await screen.findByText("Couldn't load your connected apps."),
			).toBeTruthy();
		});
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

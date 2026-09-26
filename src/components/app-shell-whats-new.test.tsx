// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsNewEntry } from "#/lib/whats-new";

/**
 * The sidebar's "New" badge (#947): a nav destination whose key is a
 * `FEATURE_KEYS` value wears it while its entry is fresh, and it clears when
 * the page is used — by clicking the entry OR by landing on the page any
 * other way (a bookmark, the panel's "Try it").
 */

const { FIXTURES } = vi.hoisted(() => {
	const today = new Date().toISOString().slice(0, 10);
	const FIXTURES: WhatsNewEntry[] = [
		{
			id: "account-page",
			title: "Account settings",
			date: today,
			audience: "everyone",
			public: false,
			featureKey: "account",
			body: "b",
		},
	];
	return { FIXTURES };
});

vi.mock("#/lib/whats-new", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/whats-new")>();
	return { ...actual, WHATS_NEW_ENTRIES: FIXTURES };
});
const server = vi.hoisted(() => ({
	getWhatsNewState: vi.fn(),
	markWhatsNewSeen: vi.fn(),
	markFeatureSeen: vi.fn(),
}));
vi.mock("#/server/whats-new", () => server);
vi.mock("#/db", () => ({ db: {} }));
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		children,
		onClick,
	}: {
		to: string;
		children: ReactNode;
		onClick?: () => void;
	}) => (
		<a
			href={to}
			onClick={(e) => {
				e.preventDefault();
				onClick?.();
			}}
		>
			{children}
		</a>
	),
	useRouterState: () => "/",
	useNavigate: () => vi.fn(),
}));

import { SidebarNav } from "./app-shell";
import { WhatsNewProvider } from "./whats-new-panel";

const MEMBER = { hasOffice: false, isOfficer: false, isSuperadmin: false };

function renderNav(pathname: string) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<WhatsNewProvider isAdmin={false}>
				<SidebarNav grants={MEMBER} pathname={pathname} />
			</WhatsNewProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	server.getWhatsNewState
		.mockReset()
		.mockResolvedValue({ seenIds: [], featuresSeen: [] });
	server.markFeatureSeen.mockReset().mockResolvedValue({ ok: true });
});
afterEach(cleanup);

function accountLink() {
	return screen.getByRole("link", { name: /account settings/i });
}

describe("sidebar New badge", () => {
	it("shows on the destination and clears when the entry is clicked", async () => {
		renderNav("/roster");
		await waitFor(() => expect(accountLink().textContent).toContain("New"));
		expect(server.markFeatureSeen).not.toHaveBeenCalled();
		await userEvent.click(accountLink());
		expect(server.markFeatureSeen).toHaveBeenCalledWith({
			data: { featureKey: "account" },
		});
		await waitFor(() => expect(accountLink().textContent).not.toContain("New"));
	});

	it("clears on landing on the page, without a click on the entry", async () => {
		renderNav("/account");
		await waitFor(() =>
			expect(server.markFeatureSeen).toHaveBeenCalledWith({
				data: { featureKey: "account" },
			}),
		);
		await waitFor(() => expect(accountLink().textContent).not.toContain("New"));
	});

	it("no badge on a destination that is not a feature key", async () => {
		renderNav("/roster");
		await waitFor(() => expect(server.getWhatsNewState).toHaveBeenCalled());
		const roster = screen.getByRole("link", { name: /roster/i });
		expect(roster.textContent).not.toContain("New");
	});
});

// @vitest-environment jsdom
//
// The mobile app bar says who is signed in and no longer carries "What's new";
// that button lives in the nav drawer, which opens from the menu button or the
// avatar. Rendered through the real `WhatsNewProvider` so the dot and the
// seen-marking are the product's own.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsNewEntry } from "#/lib/whats-new";

const { FIXTURES } = vi.hoisted(() => {
	const today = new Date().toISOString().slice(0, 10);
	const FIXTURES: WhatsNewEntry[] = [
		{
			id: "shiny",
			title: "Shiny thing",
			date: today,
			audience: "everyone",
			public: true,
			body: "Body shiny",
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
	Link: ({ to, children }: { to: string; children: ReactNode }) => (
		<a href={to}>{children}</a>
	),
	useRouterState: () => "/roster",
	useNavigate: () => vi.fn(),
	useRouter: () => ({ invalidate: vi.fn() }),
}));
vi.mock("#/server/auth-context", () => ({ setViewAs: vi.fn() }));
vi.mock("#/components/club/club-switcher", () => ({
	ClubSwitcher: () => null,
}));
vi.mock("#/components/club/global-search", () => ({
	GlobalSearch: () => null,
}));
vi.mock("#/components/club/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("#/components/ui/sonner", () => ({ Toaster: () => null }));

// A loaded machine loses to the 1s default (first render + query resolve).
const SLOW = { timeout: 5000 };

import { AppShell, shellPropsFromContext } from "./app-shell";

function renderShell() {
	const c = {
		user: { id: "u1", name: "Jane Doe", email: "jane@club.org" },
		clubs: [
			{
				clubId: "c1",
				name: "Downtown Speakers",
				clubNumber: "1234567",
				clubRole: "member" as const,
			},
		],
		currentMemberId: "m1",
		activeClubId: "c1",
		officerPositions: [] as never[],
		isSuperadmin: false,
		impersonating: null,
	};
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AppShell
				{...shellPropsFromContext(c)}
				onSignOut={vi.fn()}
				onExitImpersonation={vi.fn()}
			>
				<p>page</p>
			</AppShell>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	server.getWhatsNewState.mockReset().mockResolvedValue({
		seenIds: [],
		featuresSeen: [],
	});
	server.markWhatsNewSeen.mockReset().mockResolvedValue({ seenIds: [] });
});
afterEach(cleanup);

const mobileHeader = (container: HTMLElement) =>
	container.querySelector("header.lg\\:hidden") as HTMLElement;

describe("AppShell mobile app bar", () => {
	it("has no What's new button; the desktop header keeps its own", async () => {
		const { container } = renderShell();
		await screen.findAllByTestId("whats-new-dot");
		expect(
			within(mobileHeader(container)).queryByRole("button", {
				name: /^what's new/i,
			}),
		).toBeNull();
		const desktop = container.querySelector("header.hidden") as HTMLElement;
		expect(
			within(desktop).getByRole("button", { name: /^what's new/i }),
		).toBeTruthy();
	});

	it("shows the dot on the menu button while entries are unseen", async () => {
		const { container } = renderShell();
		const menu = await within(mobileHeader(container)).findByRole(
			"button",
			{ name: "Open navigation (new updates)" },
			SLOW,
		);
		expect(within(menu).getByTestId("whats-new-dot")).toBeTruthy();
	});

	it("no dot on the menu button once everything is seen", async () => {
		server.getWhatsNewState.mockResolvedValue({
			seenIds: ["shiny"],
			featuresSeen: [],
		});
		const { container } = renderShell();
		await waitFor(
			() =>
				expect(
					within(mobileHeader(container)).getByRole("button", {
						name: "Open navigation",
					}),
				).toBeTruthy(),
			SLOW,
		);
	});

	it("the avatar names who is signed in and opens the drawer", async () => {
		const { container } = renderShell();
		const avatar = within(mobileHeader(container)).getByRole("button", {
			name: "Account and navigation, signed in as Jane Doe",
		});
		await userEvent.click(avatar);
		const drawer = await screen.findByRole("dialog", {}, SLOW);
		expect(within(drawer).getByText("Signed in as")).toBeTruthy();
		expect(within(drawer).getByText("Jane Doe")).toBeTruthy();
	});

	it("the drawer's What's new row opens the sheet and marks entries seen", async () => {
		const { container } = renderShell();
		await userEvent.click(
			await within(mobileHeader(container)).findByRole(
				"button",
				{ name: "Open navigation (new updates)" },
				SLOW,
			),
		);
		const drawer = await screen.findByRole("dialog", {}, SLOW);
		await userEvent.click(
			within(drawer).getByRole("button", { name: /^what's new/i }),
		);
		await screen.findByText("Shiny thing", {}, SLOW);
		expect(server.markWhatsNewSeen).toHaveBeenCalledTimes(1);
		expect(server.markWhatsNewSeen.mock.calls[0][0].data.entryIds).toEqual([
			"shiny",
		]);
	});
});

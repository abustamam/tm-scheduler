// @vitest-environment jsdom
//
// ⌘K / Ctrl+K and `/` open workspace search, and the phone header has a Search
// button (#1421). GlobalSearch is replaced by a stub that exposes the real
// `GlobalSearchHandle` over a plain input, so these tests prove the SHELL's
// wiring (which input, which key, when) and not the search itself.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, type Ref, useImperativeHandle, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalSearchHandle } from "#/components/club/global-search";

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
vi.mock("#/server/whats-new", () => ({
	getWhatsNewState: vi
		.fn()
		.mockResolvedValue({ seenIds: [], featuresSeen: [] }),
	markWhatsNewSeen: vi.fn(),
	markFeatureSeen: vi.fn(),
}));
vi.mock("#/components/club/club-switcher", () => ({
	ClubSwitcher: () => null,
}));
vi.mock("#/components/club/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("#/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("#/components/club/global-search", () => ({
	GlobalSearch: ({
		variant = "popover",
		ref,
	}: {
		variant?: string;
		ref?: Ref<GlobalSearchHandle>;
	}) => {
		const input = useRef<HTMLInputElement>(null);
		useImperativeHandle(ref, () => ({
			clearResults: () => false,
			focus: () => input.current?.focus(),
		}));
		return <input aria-label={`stub-search-${variant}`} ref={input} />;
	},
}));

import { AppShell, shellPropsFromContext } from "./app-shell";

function setDesktop(isDesktop: boolean) {
	window.matchMedia = ((query: string) => ({
		matches: isDesktop,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	})) as unknown as typeof window.matchMedia;
}

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
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<AppShell
				{...shellPropsFromContext(c)}
				onSignOut={vi.fn()}
				onExitImpersonation={vi.fn()}
			>
				<input aria-label="roster filter" />
			</AppShell>
		</QueryClientProvider>,
	);
}

const SLOW = { timeout: 5000 };
afterEach(cleanup);

describe("AppShell search shortcuts (desktop)", () => {
	// protects=Ctrl+K and ⌘K focus the desktop input from anywhere and swallow the browser's own binding; fails_when=either modifier is unhandled or preventDefault is dropped; no_claim=phone layout
	it.each([
		["ctrlKey", { ctrlKey: true }],
		["metaKey", { metaKey: true }],
	])("%s+K focuses the desktop search input and prevents default", (_n, mod) => {
		setDesktop(true);
		renderShell();
		const ev = new KeyboardEvent("keydown", {
			key: "k",
			bubbles: true,
			cancelable: true,
			...mod,
		});
		document.body.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(
			screen.getByLabelText("stub-search-popover"),
		);
	});

	// protects=`/` focuses search when focus is on the page; fails_when=the key is not bound; no_claim=what happens inside inputs
	it("`/` focuses the desktop search input", () => {
		setDesktop(true);
		renderShell();
		fireEvent.keyDown(document.body, { key: "/" });
		expect(document.activeElement).toBe(
			screen.getByLabelText("stub-search-popover"),
		);
	});

	// protects=`/` typed into a field stays a typed character; fails_when=the isTypingTarget guard is missing; no_claim=Ctrl+K inside a field
	it("`/` inside another input does not move focus or get prevented", () => {
		setDesktop(true);
		renderShell();
		const filter = screen.getByLabelText("roster filter");
		filter.focus();
		const ev = new KeyboardEvent("keydown", {
			key: "/",
			bubbles: true,
			cancelable: true,
		});
		filter.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(filter);
	});

	// protects=Ctrl+K works even while typing in a field; fails_when=the typing guard also gates the modifier shortcut; no_claim=the result list
	it("Ctrl+K from inside another input still focuses search", () => {
		setDesktop(true);
		renderShell();
		screen.getByLabelText("roster filter").focus();
		fireEvent.keyDown(screen.getByLabelText("roster filter"), {
			key: "k",
			ctrlKey: true,
		});
		expect(document.activeElement).toBe(
			screen.getByLabelText("stub-search-popover"),
		);
	});
});

describe("AppShell search on a phone", () => {
	// protects=the phone header's Search button opens the drawer with its input focused; fails_when=the button is missing, opens the drawer unfocused, or focuses the hidden desktop input; no_claim=real 375px layout
	it("the Search button opens the nav drawer with the search input focused", async () => {
		setDesktop(false);
		renderShell();
		await userEvent.click(screen.getByRole("button", { name: "Search" }));
		const drawerInput = await screen.findByLabelText(
			"stub-search-inline",
			{},
			SLOW,
		);
		await vi.waitFor(() => expect(document.activeElement).toBe(drawerInput));
	});

	// protects=below lg the shortcut key does what the button does; fails_when=the key focuses the unrendered desktop input and nothing opens; no_claim=iOS hardware keyboards
	it("`/` below lg opens the drawer with search focused", async () => {
		setDesktop(false);
		renderShell();
		fireEvent.keyDown(document.body, { key: "/" });
		const drawerInput = await screen.findByLabelText(
			"stub-search-inline",
			{},
			SLOW,
		);
		await vi.waitFor(() => expect(document.activeElement).toBe(drawerInput));
	});
});

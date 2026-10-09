// @vitest-environment jsdom
//
// The Area Director's nav entries, through the WHOLE shell (#1119).
//
// `app-shell-nav.test.tsx` renders `SidebarNav` with `areas` handed straight to
// it, which cannot see the three hops in front of it: the auth context's
// `areas` reaching `shellPropsFromContext`, that result reaching `AppShell`,
// and `AppShell` reaching the sidebar. A prop dropped at any hop leaves every
// one of those tests green and the nav entry gone, so this renders `AppShell`
// from a context and reads the entry off the page.
//
// The shell's other chrome (search, the club switcher, the "what's new" panel)
// reaches server fns and `#/db`, and is not what is under test; each is a stub.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		children,
	}: {
		to: string;
		params?: Record<string, string>;
		children: ReactNode;
	}) => (
		<a href={to.replace(/\$(\w+)/g, (_, key: string) => params?.[key] ?? "")}>
			{children}
		</a>
	),
	useRouterState: () => "/roster",
	useNavigate: () => vi.fn(),
}));
vi.mock("#/components/club/club-switcher", () => ({
	ClubSwitcher: () => null,
}));
vi.mock("#/components/club/global-search", () => ({
	GlobalSearch: () => null,
}));
vi.mock("#/components/club/impersonation-banner", () => ({
	ImpersonationBanner: () => null,
}));
vi.mock("#/components/club/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("#/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("#/components/whats-new-panel", () => ({
	NewBadge: () => null,
	useIsNew: () => ({ isNew: false, markSeen: vi.fn() }),
	WhatsNewButton: () => null,
	WhatsNewProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { AppShell, shellPropsFromContext } from "./app-shell";

afterEach(cleanup);

const B2 = { id: "4a1c6d2f-7b4e-4e2c-8a6f-3d8b9c0e1f2a", label: "B2" };
const C3 = { id: "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f", label: "C3" };

function ctx(areas?: { id: string; label: string }[]) {
	return {
		user: { id: "u1", name: "Jane", email: "jane@club.org" },
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
		officerPositions: [],
		isSuperadmin: false,
		impersonating: null,
		...(areas ? { areas } : {}),
	};
}

function renderShell(areas?: { id: string; label: string }[]) {
	return render(
		<AppShell
			{...shellPropsFromContext(ctx(areas))}
			onSignOut={() => {}}
			onExitImpersonation={() => {}}
		>
			<p>page</p>
		</AppShell>,
	);
}

describe("shellPropsFromContext (#1119)", () => {
	it("hands the shell the context's areas, and none when the context has none", () => {
		expect(shellPropsFromContext(ctx([B2, C3])).areas).toEqual([B2, C3]);
		expect(shellPropsFromContext(ctx()).areas).toEqual([]);
	});
});

describe("AppShell for an Area Director (#1119)", () => {
	it("shows one Area entry per current term in the sidebar, linking to its page", () => {
		renderShell([C3, B2]);
		const entries = screen
			.getAllByRole("link")
			.filter((a) => /^Area /.test(a.textContent ?? ""));
		expect(entries.map((a) => a.textContent)).toEqual(["Area B2", "Area C3"]);
		expect(entries.map((a) => a.getAttribute("href"))).toEqual([
			`/area/${B2.id}`,
			`/area/${C3.id}`,
		]);
	});

	it("shows no Area entry to a member with no term", () => {
		renderShell([]);
		expect(screen.queryByText(/^Area /)).toBeNull();
		// Control: the shell did render its nav.
		expect(screen.getByRole("link", { name: "Roster" })).toBeTruthy();
	});
});

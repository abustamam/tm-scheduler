// @vitest-environment jsdom
//
// The signed-out club header says so, with a real Sign in button that returns
// to the current page (`/signin` validates the path with `safeRedirect`).
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));
vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		options,
		useParams: () => ({ clubId: "downtown" }),
		useRouteContext: () => ({
			clubUuid: "u",
			clubName: "Downtown Speakers",
			clubNumber: null,
			shell: false,
			authCtx: null,
			effectiveMemberId: null,
		}),
	}),
	Link: ({
		to,
		search,
		children,
		...rest
	}: {
		to: string;
		search?: { redirect?: string };
		children: ReactNode;
	}) => (
		<a href={`${to}?redirect=${search?.redirect ?? ""}`} {...rest}>
			{children}
		</a>
	),
	Outlet: () => null,
	redirect: vi.fn(),
	useRouter: () => ({ navigate: vi.fn() }),
	useRouterState: () => "/club/downtown/meeting/m1?x=1",
}));
vi.mock("#/components/club/identity-gate", () => ({
	IdentityGateProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("#/components/club/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("#/components/public-footer", () => ({ PublicFooter: () => null }));
vi.mock("#/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("#/components/app-shell", () => ({
	AppShell: () => null,
	shellPropsFromContext: () => ({}),
}));
vi.mock("#/lib/auth-client", () => ({ authClient: {} }));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/lib/public-shell", () => ({ publicShellDecision: vi.fn() }));
vi.mock("#/server/auth-context", () => ({ getAuthContext: vi.fn() }));
vi.mock("#/server/impersonation", () => ({ endImpersonation: vi.fn() }));

import { Route } from "./club.$clubId";

afterEach(cleanup);

describe("anonymous club header", () => {
	it("renders a Sign in button back to the current page, and a Not signed in label", () => {
		const Shell = (
			Route as unknown as { options: { component: () => ReactNode } }
		).options.component;
		render(<Shell />);
		const link = screen.getByRole("link", { name: "Sign in" });
		expect(link.getAttribute("href")).toBe(
			"/signin?redirect=/club/downtown/meeting/m1?x=1",
		);
		expect(link.getAttribute("data-slot")).toBe("button");
		expect(screen.getByText("Not signed in")).toBeTruthy();
	});
});

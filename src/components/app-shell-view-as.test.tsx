// @vitest-environment jsdom
//
// "Preview as member" through the WHOLE shell (#1113): the button, the banner,
// and the nav the downgraded context produces. `app-shell-nav.test.tsx` renders
// `SidebarNav` with grants handed straight to it, which cannot see the hops in
// front of it (auth context -> `applyViewAs` -> `shellPropsFromContext` ->
// `AppShell`), so this renders the shell from a context.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	setViewAs: vi.fn(async (_: unknown) => ({ ok: true as const })),
	invalidate: vi.fn(async () => {}),
}));

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
	useRouter: () => ({ invalidate: hoisted.invalidate }),
}));
vi.mock("#/server/auth-context", () => ({ setViewAs: hoisted.setViewAs }));
vi.mock("#/components/club/club-switcher", () => ({
	ClubSwitcher: () => null,
}));
vi.mock("#/components/club/global-search", () => ({
	GlobalSearch: () => null,
}));
vi.mock("#/components/club/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("#/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("#/components/whats-new-panel", () => ({
	NewBadge: () => null,
	useIsNew: () => ({ isNew: false, markSeen: vi.fn() }),
	WhatsNewButton: () => null,
	WhatsNewProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { applyViewAs } from "#/lib/view-as";
import { AppShell, shellPropsFromContext } from "./app-shell";

beforeEach(() => {
	hoisted.setViewAs.mockClear();
	hoisted.invalidate.mockClear();
});
afterEach(cleanup);

type Role = "admin" | "member";

/** What `getAuthContext` returns for this person, cookie applied or not. */
function ctx(opts: { role: Role; preview: boolean; impersonating?: boolean }) {
	const base = {
		user: { id: "u1", name: "Jane", email: "jane@club.org" },
		clubs: [
			{
				clubId: "c1",
				name: "Downtown Speakers",
				clubNumber: "1234567",
				clubRole: opts.role,
			},
		],
		currentMemberId: "m1",
		activeClubId: "c1",
		officerPositions: [] as never[],
		isSuperadmin: false,
		impersonating: opts.impersonating
			? {
					expiresAt: new Date(Date.now() + 600_000),
					mode: "read_only" as const,
				}
			: null,
	};
	return applyViewAs(base, opts.preview ? "member" : null);
}

function renderShell(
	c: ReturnType<typeof ctx>,
	onSignOut = vi.fn(),
	onExitImpersonation = vi.fn(),
) {
	return {
		onSignOut,
		onExitImpersonation,
		...render(
			<AppShell
				{...shellPropsFromContext(c)}
				onSignOut={onSignOut}
				onExitImpersonation={onExitImpersonation}
			>
				<p>page</p>
			</AppShell>,
		),
	};
}

const adminLinks = (c: HTMLElement) =>
	c.querySelectorAll('a[href="/officers"], a[href="/admin/dues"]').length;

describe("AppShell preview as member (#1113)", () => {
	it("offers an admin the button, and no banner", () => {
		const { container } = renderShell(ctx({ role: "admin", preview: false }));
		expect(
			screen.getAllByRole("button", { name: "Preview as member" }).length,
		).toBeGreaterThan(0);
		expect(screen.queryByText("Previewing as a member")).toBeNull();
		expect(adminLinks(container)).toBeGreaterThan(0);
	});

	it("never offers a plain member the button", () => {
		renderShell(ctx({ role: "member", preview: false }));
		expect(screen.queryByRole("button", { name: "Preview as member" })).toBe(
			null,
		);
	});

	it("shows a plain member who set the cookie by hand no banner and no change", () => {
		const { container } = renderShell(ctx({ role: "member", preview: true }));
		expect(screen.queryByText("Previewing as a member")).toBeNull();
		expect(adminLinks(container)).toBe(0);
	});

	it("in preview: admin nav entries are gone, the banner shows, the button is hidden", () => {
		const { container } = renderShell(ctx({ role: "admin", preview: true }));
		expect(adminLinks(container)).toBe(0);
		expect(screen.getByText("Previewing as a member")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Preview as member" })).toBe(
			null,
		);
		// The role label is the member's.
		expect(screen.getAllByText("Member").length).toBeGreaterThan(0);
	});

	it("clicking the button sets the cookie, then re-runs the loaders", async () => {
		renderShell(ctx({ role: "admin", preview: false }));
		const [button] = screen.getAllByRole("button", {
			name: "Preview as member",
		});
		await userEvent.click(button as HTMLElement);
		await waitFor(() => expect(hoisted.invalidate).toHaveBeenCalledTimes(1));
		expect(hoisted.setViewAs).toHaveBeenCalledWith({
			data: { viewAs: "member" },
		});
	});

	it("Exit clears the cookie, then re-runs the loaders", async () => {
		renderShell(ctx({ role: "admin", preview: true }));
		await userEvent.click(screen.getByRole("button", { name: /Exit/ }));
		await waitFor(() => expect(hoisted.invalidate).toHaveBeenCalledTimes(1));
		expect(hoisted.setViewAs).toHaveBeenCalledWith({
			data: { viewAs: null },
		});
	});

	it("impersonating AND previewing renders ONE banner carrying both facts", async () => {
		renderShell(ctx({ role: "admin", preview: true, impersonating: true }));
		// Not the standalone preview banner.
		expect(screen.queryByText("Previewing as a member")).toBeNull();
		expect(screen.getByText(/previewing as a member/)).toBeTruthy();
		expect(screen.getByText(/as platform support/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /Exit preview/ }));
		await waitFor(() => expect(hoisted.invalidate).toHaveBeenCalledTimes(1));
		expect(hoisted.setViewAs).toHaveBeenCalledWith({
			data: { viewAs: null },
		});
	});

	it("Exit on the combined banner is the impersonation exit, not the preview's", async () => {
		const { onExitImpersonation } = renderShell(
			ctx({ role: "admin", preview: true, impersonating: true }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Exit" }));
		expect(onExitImpersonation).toHaveBeenCalledTimes(1);
		expect(hoisted.setViewAs).not.toHaveBeenCalled();
	});

	it("sign out WAITS for the preview to clear before signing out", async () => {
		let release: () => void = () => {};
		hoisted.setViewAs.mockImplementationOnce(
			() =>
				new Promise<{ ok: true }>((resolve) => {
					release = () => resolve({ ok: true as const });
				}),
		);
		const onSignOut = vi.fn();
		renderShell(ctx({ role: "admin", preview: true }), onSignOut);
		const [signOut] = screen.getAllByRole("button", { name: "Sign out" });
		await userEvent.click(signOut as HTMLElement);
		await waitFor(() => expect(hoisted.setViewAs).toHaveBeenCalledTimes(1));
		// Cleared is still in flight: signing out now would let the next person on
		// this browser inherit the preview.
		expect(onSignOut).not.toHaveBeenCalled();
		release();
		await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
	});

	it("still signs out when clearing the preview fails", async () => {
		hoisted.setViewAs.mockRejectedValueOnce(new Error("offline"));
		const onSignOut = vi.fn();
		renderShell(ctx({ role: "admin", preview: true }), onSignOut);
		const [signOut] = screen.getAllByRole("button", { name: "Sign out" });
		await userEvent.click(signOut as HTMLElement);
		await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
	});
});

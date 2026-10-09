// @vitest-environment jsdom
//
// The `_authed` layout's choice of frame for a person with NO club (#1119).
//
// It used to answer `NoClubScreen` for every route, which dead-ended two people
// whose pages need no club: an Area Director at `/area/<id>`, and a superadmin
// at `/superadmin` (the "Go to Superadmin" button landed on `NoClubScreen`
// again). Now those two paths render the page in a minimal frame; every other
// path, and everyone else, keeps `NoClubScreen`.
//
// It renders the real layout component with the router hooks stubbed, and the
// workspace shell replaced by a marker: what is under test is WHICH frame wraps
// the outlet, not the shell's own chrome. A frame is not an authorization; the
// pages keep their own gates (`area-guards.integration.test.ts`).
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	pathname: { current: "/" },
	getAuthContext: vi.fn(),
	shellPropsFromContext: vi.fn(() => ({})),
}));

vi.mock("#/server/auth-context", () => ({
	getAuthContext: hoisted.getAuthContext,
}));
vi.mock("#/server/impersonation", () => ({ endImpersonation: vi.fn() }));
vi.mock("#/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("#/components/connected-apps-section", () => ({
	ConnectedAppsSection: () => null,
}));
// The shell reaches `#/db` through its server fns; a marker says which frame won.
vi.mock("#/components/app-shell", () => ({
	AppShell: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="workspace-shell">{children}</div>
	),
	shellPropsFromContext: hoisted.shellPropsFromContext,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// The frame mounts the toaster; the library's own is not what is under test.
vi.mock("#/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Outlet: () => <div data-testid="outlet" />,
	useRouter: () => ({ navigate: vi.fn(), invalidate: vi.fn() }),
	useRouterState: () => hoisted.pathname.current,
}));

import { renderUnderMemoryRouter } from "#/test/router-harness";
import { Route } from "./_authed";

const AREA_ID = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

interface Ctx {
	clubs: { clubId: string; name: string }[];
	isSuperadmin: boolean;
	areas: { id: string; label: string }[];
}

async function renderLayout(pathname: string, over: Partial<Ctx> = {}) {
	hoisted.pathname.current = pathname;
	const ctx: Ctx = { clubs: [], isSuperadmin: false, areas: [], ...over };
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		authUser: { id: "u1", name: "Jane", email: "jane@club.org" },
		currentMemberId: null,
		activeClubId: null,
		officerPositions: [],
		impersonating: null,
		archivedClubCount: 0,
		...ctx,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Layout = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Layout />);
}

const DIRECTOR = { areas: [{ id: AREA_ID, label: "C3" }] };

describe("a club-less Area Director (#1119)", () => {
	it("sees the area page at /area/<id>, in the minimal frame and not NoClubScreen", async () => {
		await renderLayout(`/area/${AREA_ID}`, DIRECTOR);
		expect(screen.getByTestId("outlet")).toBeTruthy();
		expect(screen.queryByText("You're not in a club yet")).toBeNull();
		// The minimal frame: sign out, and no club workspace shell.
		expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
		expect(screen.queryByTestId("workspace-shell")).toBeNull();
	});

	it("still lands on NoClubScreen anywhere else, with the Go to Area button", async () => {
		await renderLayout("/dashboard", DIRECTOR);
		expect(screen.queryByTestId("outlet")).toBeNull();
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Go to Area C3" }).getAttribute("href"),
		).toBe(`/area/${AREA_ID}`);
	});
});

describe("a club-less person with no current term (#1119)", () => {
	it("still sees NoClubScreen at /area/<id>", async () => {
		await renderLayout(`/area/${AREA_ID}`, { areas: [] });
		expect(screen.queryByTestId("outlet")).toBeNull();
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
		expect(screen.queryByRole("link", { name: /go to area/i })).toBeNull();
	});
});

describe("a club-less superadmin (#1119)", () => {
	it("reaches /superadmin and what is under it, not NoClubScreen again", async () => {
		await renderLayout("/superadmin", { isSuperadmin: true });
		expect(screen.getByTestId("outlet")).toBeTruthy();
		expect(screen.queryByText("You're not in a club yet")).toBeNull();
		cleanup();

		await renderLayout("/superadmin/areas", { isSuperadmin: true });
		expect(screen.getByTestId("outlet")).toBeTruthy();
	});

	it("keeps NoClubScreen on every other path, and on a look-alike of /superadmin", async () => {
		await renderLayout("/dashboard", { isSuperadmin: true });
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
		cleanup();

		await renderLayout("/superadmins", { isSuperadmin: true });
		expect(screen.queryByTestId("outlet")).toBeNull();
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
	});

	it("does not open /area/<id> to a superadmin with no term", async () => {
		await renderLayout(`/area/${AREA_ID}`, { isSuperadmin: true, areas: [] });
		expect(screen.queryByTestId("outlet")).toBeNull();
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
	});
});

describe("a club-less non-superadmin at /superadmin (#1119)", () => {
	it("still sees NoClubScreen", async () => {
		await renderLayout("/superadmin", { isSuperadmin: false });
		expect(screen.queryByTestId("outlet")).toBeNull();
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
		expect(
			screen.queryByRole("link", { name: /go to superadmin/i }),
		).toBeNull();
	});

	it("does not even with a term: a term opens /area, not the console", async () => {
		await renderLayout("/superadmin", DIRECTOR);
		expect(screen.queryByTestId("outlet")).toBeNull();
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
	});
});

describe("a person with a club (#1119)", () => {
	it("keeps the workspace shell, and hands it their areas", async () => {
		await renderLayout(`/area/${AREA_ID}`, {
			...DIRECTOR,
			clubs: [{ clubId: "c1", name: "Downtown Speakers" }],
		});
		expect(screen.getByTestId("workspace-shell")).toBeTruthy();
		expect(screen.queryByText("You're not in a club yet")).toBeNull();
		expect(hoisted.shellPropsFromContext).toHaveBeenCalledWith(
			expect.objectContaining({ areas: DIRECTOR.areas }),
		);
	});
});

describe("beforeLoad (#1119)", () => {
	it("puts the auth context's areas on the route context", async () => {
		hoisted.getAuthContext.mockResolvedValue({
			user: { id: "u1", name: "Jane", email: "jane@club.org" },
			clubs: [],
			currentMemberId: null,
			activeClubId: null,
			officerPositions: [],
			isSuperadmin: false,
			impersonating: null,
			archivedClubCount: 0,
			areas: DIRECTOR.areas,
		});
		const beforeLoad = Route.options.beforeLoad as (args: {
			location: { href: string };
		}) => Promise<{ areas: unknown }>;
		const result = await beforeLoad({ location: { href: "/area/x" } });
		expect(result.areas).toEqual(DIRECTOR.areas);
	});
});

// @vitest-environment jsdom
//
// The route → guest-surface seam (#318 / #319).
//
// `AboutClub`, `VisitCta` and `GuestResources` each have thorough component
// tests — that all inject their props. Nothing tested who SUPPLIES them, and
// that gap hid a real bug: `VisitCta` was wired `isMember={shell}`, which is
// true only for a SIGNED-IN member, so a member who identified through the
// anonymous roster pick (the dominant path in this no-auth product) was shown
// "Planning a visit? Guests are always welcome" on their own sign-up sheet.
// Every component test passed, because each one hands `hasIdentity` in itself.
//
// Same class of seam as `club-logo-loaders.test.ts` (#496). Two shapes here,
// because the two routes need different tools:
//
//   • The roles-guide COMPONENT is rendered, following the pattern documented
//     in `club.$clubId_.meeting.$meetingId.word.test.tsx:12-21` — mock the
//     route's `#/server/*` imports, spy `Route.useParams`/`useLoaderData`/
//     `useRouteContext`, mount under a minimal memory router so `<Link>`
//     resolves an href.
//   • The club-index JSX WIRING is asserted by a comment-blind source guard
//     (`club-index-wiring.guard.test.ts`). Rendering that route would need a
//     QueryClientProvider, the identity gate and the whole SeasonGrid just to
//     observe one boolean expression; the guard pins the expression directly
//     and fails on exactly the revert that matters.
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/clubs", () => ({ getPublicClubProfileFn: vi.fn() }));
vi.mock("#/server/season-grid", () => ({ getPublicSeasonGrid: vi.fn() }));
vi.mock("#/server/role-definitions", () => ({ getPublicClubRoles: vi.fn() }));
// Reached transitively by the club index route through the components it
// renders (identity-gate → pick-name-form → #/server/members; season-grid →
// #/server/availability; the claim/release handlers). Every one imports `#/db`
// → `pg`, which must not load in a unit test. Importing the ROUTE pulls its
// whole component tree, so the mock list is the route's transitive `#/server/*`
// set, not just what the loader itself calls.
vi.mock("#/server/members", () => ({
	listMembers: vi.fn(),
}));
vi.mock("#/server/meetings", () => ({ listMemberCommitments: vi.fn() }));
vi.mock("#/server/slots", () => ({ releaseSlot: vi.fn(), claimSlot: vi.fn() }));
vi.mock("#/server/availability", () => ({
	getMemberAvailability: vi.fn(),
	setMemberAvailability: vi.fn(),
}));

import { getPublicClubProfileFn } from "#/server/clubs";
import { getPublicClubRoles } from "#/server/role-definitions";
import { getPublicSeasonGrid } from "#/server/season-grid";
import { Route as ClubIndexRoute } from "./club.$clubId.index";
import { Route as RolesGuideRoute } from "./club.$clubId.roles-guide";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

const PROFILE = {
	district: "District 206",
	mission: "Building leaders.",
	meetingSchedule: "2nd & 4th Thursday, 6:45 PM",
};

// biome-ignore lint/suspicious/noExplicitAny: narrowing a TanStack union — the
// object variant of `loader` carries no call signature, so a direct call is
// refused even though both routes define the function form.
function runLoader(route: { options: { loader?: any } }, c: unknown) {
	return route.options.loader(c);
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getPublicSeasonGrid).mockResolvedValue({} as never);
	vi.mocked(getPublicClubProfileFn).mockResolvedValue(PROFILE as never);
	vi.mocked(getPublicClubRoles).mockResolvedValue([] as never);
});

describe("club index loader (#318)", () => {
	it("returns the grid AND the club profile", async () => {
		const data = await runLoader(ClubIndexRoute, {
			context: { clubUuid: CLUB_ID },
			deps: { count: 8 },
		});
		expect(getPublicClubProfileFn).toHaveBeenCalledWith({ data: CLUB_ID });
		// Dropping `profile` from the loader makes AboutClub render nothing on
		// every club page; assert the VALUE, not just that the fn was called.
		expect(data.profile).toEqual(PROFILE);
		expect(data).toHaveProperty("grid");
	});

	/**
	 * The profile is decorative; the sign-up sheet is the primary surface. A
	 * profile failure must degrade to "no About block", never 500 the page —
	 * `Promise.all` rejects on the first rejection, so the `.catch` is the only
	 * thing standing between a bad profile query and a dead public club page.
	 */
	it("still renders the page when the profile query fails", async () => {
		vi.mocked(getPublicClubProfileFn).mockRejectedValue(new Error("db down"));
		const data = await runLoader(ClubIndexRoute, {
			context: { clubUuid: CLUB_ID },
			deps: { count: 8 },
		});
		expect(data.profile).toBeNull();
		expect(data).toHaveProperty("grid");
	});

	it("fails the page when the GRID query fails — that one is not optional", async () => {
		vi.mocked(getPublicSeasonGrid).mockRejectedValue(new Error("db down"));
		await expect(
			runLoader(ClubIndexRoute, {
				context: { clubUuid: CLUB_ID },
				deps: { count: 8 },
			}),
		).rejects.toThrow(/db down/);
	});
});

describe("roles-guide loader (#318)", () => {
	it("loads THIS club's roles", async () => {
		await runLoader(RolesGuideRoute, { context: { clubUuid: CLUB_ID } });
		expect(getPublicClubRoles).toHaveBeenCalledWith({ data: CLUB_ID });
	});

	it("titles the tab with the club name", () => {
		// biome-ignore lint/suspicious/noExplicitAny: head takes a router match
		const head = (RolesGuideRoute.options.head as any)({
			match: { context: { clubName: "Harbor City Speakers" } },
		});
		expect(head.meta[0].title).toContain("Harbor City Speakers");
	});

	/**
	 * The whole `/club/$clubId/*` subtree is deliberately `noindex, nofollow`,
	 * set once on the shell. This is the FIRST child of that shell to declare a
	 * `head` of its own, so it is the first chance to accidentally replace the
	 * parent's robots meta instead of merging with it. Pin that the child
	 * contributes ONLY a title.
	 */
	it("adds only a title, so the shell's noindex survives the merge", () => {
		// biome-ignore lint/suspicious/noExplicitAny: head takes a router match
		const head = (RolesGuideRoute.options.head as any)({
			match: { context: { clubName: "Harbor City Speakers" } },
		});
		expect(head.meta).toHaveLength(1);
		expect(head.meta[0]).not.toHaveProperty("name");
		expect(head.meta[0]).not.toHaveProperty("content");
	});
});

/**
 * The roles-guide COMPONENT (#318). The loader tests above prove the right data
 * is fetched; these prove what a guest actually sees.
 *
 * Renders under a memory router carrying both link targets so `<Link>` resolves
 * a real href — the printable link is the one that used to be a hand-built
 * string, and asserting its resolved href is what makes a rename of
 * `club.$clubId_.roles.tsx` fail here instead of shipping a 404 to guests.
 */
describe("roles-guide component (#318)", () => {
	const ROLES = [
		{
			id: "r1",
			name: "Toastmaster of the Day",
			category: "leadership" as const,
			description: "Hosts the meeting.",
			defaultCount: 1,
			sortOrder: 0,
			isSpeakerRole: false,
			enabled: true,
		},
		{
			id: "r2",
			name: "Timer",
			category: "functionary" as const,
			// A role with NO description — the `r.description ? … : null` branch.
			description: null,
			defaultCount: 1,
			sortOrder: 1,
			isSpeakerRole: false,
			enabled: true,
		},
	];

	async function renderGuide(roles: unknown[]) {
		vi.spyOn(RolesGuideRoute, "useParams").mockReturnValue({
			clubId: "harbor-city",
		} as never);
		vi.spyOn(RolesGuideRoute, "useLoaderData").mockReturnValue(roles as never);
		vi.spyOn(RolesGuideRoute, "useRouteContext").mockReturnValue({
			clubName: "Harbor City Speakers",
		} as never);

		const Component = RolesGuideRoute.options.component as React.ComponentType;
		const rootRoute = createRootRoute({ component: () => <Component /> });
		const stub = (path: string) =>
			createRoute({
				getParentRoute: () => rootRoute,
				path,
				component: () => null,
			});
		rootRoute.addChildren([stub("/club/$clubId"), stub("/club/$clubId/roles")]);
		const router = createRouter({
			routeTree: rootRoute,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		render(<RouterProvider router={router} />);
		await waitFor(() => expect(router.state.status).toBe("idle"));
	}

	it("renders the club's roles grouped, in CATEGORY_ORDER", async () => {
		await renderGuide(ROLES);
		expect(screen.getByText("Toastmaster of the Day")).toBeTruthy();
		expect(screen.getByText("Timer")).toBeTruthy();
		expect(screen.getByText("Hosts the meeting.")).toBeTruthy();
		// Leadership precedes Functionary Roles in CATEGORY_ORDER; assert the
		// rendered ORDER, not just presence.
		const html = document.body.innerHTML;
		expect(html.indexOf("Leadership")).toBeLessThan(
			html.indexOf("Functionary Roles"),
		);
	});

	it("omits the description block for a role that has none", async () => {
		await renderGuide(ROLES);
		// "Timer" renders; no stray empty paragraph follows it. Assert the count
		// of rendered descriptions rather than the absence of a string, so this
		// cannot pass by the text simply not matching.
		expect(screen.getAllByText(/Hosts the meeting\./)).toHaveLength(1);
		expect(screen.queryByText("null")).toBeNull();
	});

	it("shows the empty state and NO category headings for a club with no roles", async () => {
		await renderGuide([]);
		expect(
			screen.getByText(/hasn't set up its meeting roles yet/i),
		).toBeTruthy();
		for (const label of ["Leadership", "Speaking Roles", "Evaluation"]) {
			expect(screen.queryByText(label)).toBeNull();
		}
	});

	it("links the printable version at THIS club's print route", async () => {
		await renderGuide(ROLES);
		expect(
			screen
				.getByRole("link", { name: /printable version/i })
				.getAttribute("href"),
		).toBe("/club/harbor-city/roles");
	});

	it("offers a way back to the club", async () => {
		await renderGuide(ROLES);
		const back = screen.getByRole("link", { name: /back to harbor city/i });
		expect(back.getAttribute("href")).toContain("/club/harbor-city");
	});
});

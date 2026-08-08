/**
 * The route → guest-surface seam (#318 / #319).
 *
 * `AboutClub`, `VisitCta` and `GuestResources` each have thorough component
 * tests — that all inject their props. Nothing tested who SUPPLIES them, and
 * that gap hid a real bug: `VisitCta` was wired `isMember={shell}`, which is
 * true only for a SIGNED-IN member, so a member who identified through the
 * anonymous roster pick (the dominant path in this no-auth product) was shown
 * "Planning a visit? Guests are always welcome" on their own sign-up sheet.
 * Every component test passed, because each one hands `hasIdentity` in itself.
 *
 * Same class of seam as `club-logo-loaders.test.ts` (#496), and these follow its
 * pattern: mock the route's server-fn imports (they reach `#/db` → `pg`, which
 * must not load here) and call `Route.options.loader` directly — it is a plain
 * function.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
	addMember: vi.fn(),
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

// @vitest-environment jsdom
//
// The two "next meeting" routes (#1140): the per-club permalink
// `/club/$clubId/next` and the signed-in shortcut `/_authed/next`.
//
// Both ask ONE server fn, `getPublicNextMeetingKey`, which is mocked here: what
// the fn answers for a given date is `next-meeting-key.integration.test.ts`'s
// business. These tests pin what each route DOES with the answer — where it
// redirects, with which params and search, and what the empty state shows — in
// the `Route.options.loader` style of `club-guest-surfaces.test.tsx`.
//
// The empty-state COMPONENT is rendered under a memory router, following the
// pattern in that file: spy `Route.useParams` / `useLoaderData`, and stub the
// link targets so `<Link>` resolves a real href.
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	isRedirect,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({ getPublicNextMeetingKey: vi.fn() }));

import { getPublicNextMeetingKey } from "#/server/meetings";
import { Route as AuthedNextRoute } from "./_authed/next";
import { Route as ClubNextRoute } from "./club.$clubId.next";

const CLUB_UUID = "11111111-1111-4111-8111-111111111111";
const SLUG = "harbor-city";

// The object variant of `loader` carries no call signature, so a direct call is
// refused even though both routes define the function form.
// biome-ignore lint/suspicious/noExplicitAny: narrowing a TanStack union
type AnyRoute = { options: any };

/** Run a loader and hand back whatever it threw, or returned. */
async function run(
	route: AnyRoute,
	c: unknown,
): Promise<{ thrown: unknown; value: unknown }> {
	try {
		return { thrown: undefined, value: await route.options.loader(c) };
	} catch (thrown) {
		return { thrown, value: undefined };
	}
}

/** The options of a thrown redirect, failing loudly if it was anything else. */
function redirectOptions(thrown: unknown) {
	expect(isRedirect(thrown)).toBe(true);
	// biome-ignore lint/suspicious/noExplicitAny: redirect options
	return (thrown as any).options as {
		to: string;
		params?: Record<string, string>;
		search?: Record<string, unknown>;
	};
}

const MEETING = "/club/$clubId/meeting/$meetingId";

/** A shell context for the club, signed out unless an `authCtx` is given. */
function clubContext(authCtx: unknown = null) {
	return {
		clubUuid: CLUB_UUID,
		clubSlug: SLUG,
		clubName: "Harbor City Speakers",
		authCtx,
	};
}

/** The slice of the auth context `effectiveAdminClubFor` reads. */
function authCtxFor(role: "admin" | "member", clubId = CLUB_UUID) {
	return {
		activeClubId: clubId,
		officerPositions: [],
		clubs: [{ clubId, clubRole: role }],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("/club/$clubId/next loader (#1140)", () => {
	it("redirects to THIS club's meeting by slug, asking the seam with the club's uuid", async () => {
		vi.mocked(getPublicNextMeetingKey).mockResolvedValue({
			clubSlug: SLUG,
			urlKey: "2030-06-11",
		});
		const { thrown } = await run(ClubNextRoute, {
			context: clubContext(),
			deps: { room: false },
		});

		expect(getPublicNextMeetingKey).toHaveBeenCalledWith({ data: CLUB_UUID });
		const opts = redirectOptions(thrown);
		expect(opts.to).toBe(MEETING);
		// The slug from the SHELL's context, not the uuid the fn was asked with.
		expect(opts.params).toEqual({ clubId: SLUG, meetingId: "2030-06-11" });
		expect((thrown as Response).status).toBe(307);
	});

	it("forwards `?room=1` and nothing else", async () => {
		vi.mocked(getPublicNextMeetingKey).mockResolvedValue({
			clubSlug: SLUG,
			urlKey: "2030-06-11",
		});
		const { thrown } = await run(ClubNextRoute, {
			context: clubContext(),
			deps: { room: true },
		});
		expect(redirectOptions(thrown).search).toEqual({ room: 1 });
	});

	it("drops every other search param: `?as=x&foo=y` redirects bare", async () => {
		vi.mocked(getPublicNextMeetingKey).mockResolvedValue({
			clubSlug: SLUG,
			urlKey: "2030-06-11",
		});
		// `loaderDeps` is the ONLY thing the loader reads of the search, so feed
		// the real one the real search and hand its output to the loader.
		const deps = ClubNextRoute.options.loaderDeps?.({
			// The URL carries keys `validateSearch`'s type does not name.
			search: { as: "x", foo: "y" } as never,
		});
		expect(deps).toEqual({ room: false });
		const { thrown } = await run(ClubNextRoute, {
			context: clubContext(),
			deps,
		});
		expect(redirectOptions(thrown).search).toEqual({});
	});

	it("reads `room` as the QR writes it, number or string", () => {
		const loaderDeps = ClubNextRoute.options.loaderDeps;
		expect(loaderDeps?.({ search: { room: 1 } })).toEqual({ room: true });
		expect(loaderDeps?.({ search: { room: "1" } })).toEqual({ room: true });
		expect(loaderDeps?.({ search: { room: 2 } })).toEqual({ room: false });
		expect(loaderDeps?.({ search: {} })).toEqual({ room: false });
	});

	it("with no next meeting, returns canSchedule=false for a guest", async () => {
		vi.mocked(getPublicNextMeetingKey).mockResolvedValue({
			clubSlug: SLUG,
			urlKey: null,
		});
		const { thrown, value } = await run(ClubNextRoute, {
			context: clubContext(),
			deps: { room: false },
		});
		expect(thrown).toBeUndefined();
		expect(value).toEqual({ canSchedule: false });
	});

	it("an archived club's null answer is the same empty state, not a throw", async () => {
		vi.mocked(getPublicNextMeetingKey).mockResolvedValue(null);
		const { thrown, value } = await run(ClubNextRoute, {
			context: clubContext(),
			deps: { room: false },
		});
		expect(thrown).toBeUndefined();
		expect(value).toEqual({ canSchedule: false });
	});

	it("canSchedule is true for an effective admin of THIS club, false for a member or another club's admin", async () => {
		vi.mocked(getPublicNextMeetingKey).mockResolvedValue({
			clubSlug: SLUG,
			urlKey: null,
		});
		const can = async (authCtx: unknown) =>
			(
				(await run(ClubNextRoute, {
					context: clubContext(authCtx),
					deps: { room: false },
				})) as { value: { canSchedule: boolean } }
			).value.canSchedule;

		expect(await can(authCtxFor("admin"))).toBe(true);
		expect(await can(authCtxFor("member"))).toBe(false);
		// Admin of a DIFFERENT club: a signed-in non-member sees the guest state.
		expect(
			await can(authCtxFor("admin", "22222222-2222-4222-8222-222222222222")),
		).toBe(false);
	});
});

describe("/club/$clubId/next empty state (#1140)", () => {
	async function renderEmptyState(canSchedule: boolean) {
		vi.spyOn(ClubNextRoute, "useParams").mockReturnValue({
			clubId: SLUG,
		} as never);
		vi.spyOn(ClubNextRoute, "useLoaderData").mockReturnValue({
			canSchedule,
		} as never);

		const Component = ClubNextRoute.options.component as React.ComponentType;
		const rootRoute = createRootRoute({ component: () => <Component /> });
		const stub = (path: string) =>
			createRoute({
				getParentRoute: () => rootRoute,
				path,
				component: () => null,
			});
		rootRoute.addChildren([stub("/club/$clubId"), stub("/admin/meetings/new")]);
		const router = createRouter({
			routeTree: rootRoute,
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		render(<RouterProvider router={router} />);
		await waitFor(() => expect(router.state.status).toBe("idle"));
	}

	it("tells a guest or member there is no meeting and links THIS club's sign-up sheet", async () => {
		await renderEmptyState(false);
		expect(screen.getByRole("heading", { name: "Next meeting" })).toBeTruthy();
		expect(
			screen.getByText("No upcoming meeting is scheduled yet."),
		).toBeTruthy();
		const href = screen
			.getByRole("link", { name: /browse the sign-up sheet/i })
			.getAttribute("href");
		// Pathname only: the link also carries the sheet's default view params.
		expect(href?.split("?")[0]).toBe(`/club/${SLUG}`);
		expect(
			screen.queryByRole("link", { name: /schedule a meeting/i }),
		).toBeNull();
	});

	it("gives an effective admin 'Schedule a meeting' instead", async () => {
		await renderEmptyState(true);
		expect(
			screen
				.getByRole("link", { name: /schedule a meeting/i })
				.getAttribute("href"),
		).toBe("/admin/meetings/new");
		expect(
			screen.queryByRole("link", { name: /browse the sign-up sheet/i }),
		).toBeNull();
	});
});

describe("/_authed/next loader (#1140)", () => {
	it("with no active club, goes to the dashboard without asking the seam", async () => {
		const { thrown } = await run(AuthedNextRoute, {
			context: { activeClubId: null },
		});
		expect(redirectOptions(thrown).to).toBe("/dashboard");
		expect(getPublicNextMeetingKey).not.toHaveBeenCalled();
	});

	it("with an unreadable (null) club, goes to the dashboard", async () => {
		vi.mocked(getPublicNextMeetingKey).mockResolvedValue(null);
		const { thrown } = await run(AuthedNextRoute, {
			context: { activeClubId: CLUB_UUID },
		});
		expect(getPublicNextMeetingKey).toHaveBeenCalledWith({ data: CLUB_UUID });
		expect(redirectOptions(thrown).to).toBe("/dashboard");
	});

	it("with a next meeting, goes straight to it in one hop, never via /club/<slug>/next", async () => {
		vi.mocked(getPublicNextMeetingKey).mockResolvedValue({
			clubSlug: SLUG,
			urlKey: "2030-06-11",
		});
		const { thrown } = await run(AuthedNextRoute, {
			context: { activeClubId: CLUB_UUID },
		});
		const opts = redirectOptions(thrown);
		expect(opts.to).toBe(MEETING);
		expect(opts.params).toEqual({ clubId: SLUG, meetingId: "2030-06-11" });
	});

	it("with a club but no meeting, hands over to the permalink's empty state", async () => {
		vi.mocked(getPublicNextMeetingKey).mockResolvedValue({
			clubSlug: SLUG,
			urlKey: null,
		});
		const { thrown } = await run(AuthedNextRoute, {
			context: { activeClubId: CLUB_UUID },
		});
		const opts = redirectOptions(thrown);
		expect(opts.to).toBe("/club/$clubId/next");
		expect(opts.params).toEqual({ clubId: SLUG });
	});
});

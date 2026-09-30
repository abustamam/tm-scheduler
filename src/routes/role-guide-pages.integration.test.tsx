// @vitest-environment jsdom
//
// The role guide at PAGE level (#933): what the roles guide and the personal
// meeting page actually serve for an archived club, and that the roles guide
// is the same page for a signed-out visitor as for another club's member.
//
// The server fns are the only seam replaced, and each is replaced by a thin
// call into the REAL gated logic against the test database — so these run the
// route's own loader and component over data the archive gate actually
// decided, rather than over a fixture that assumes the answer:
//
//   getPublicClubRoles     → loadPublicClubRoles (its handler is exactly that)
//   getPublicMeetingByKey  → resolvePublicMeetingKey, the resolver its handler
//                            gates on, throwing its "Meeting not found." on null
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	isNotFound,
	RouterProvider,
} from "@tanstack/react-router";
import { render, cleanup as rtlCleanup, waitFor } from "@testing-library/react";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, roleDefinitions } from "#/db/schema";
import { roleSeed } from "#/lib/role-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("#/server/role-definitions", async () => {
	const logic = await import("#/server/role-definitions-logic");
	return {
		getPublicClubRoles: ({ data }: { data: string }) =>
			logic.loadPublicClubRoles(data),
	};
});
vi.mock("#/server/meetings", async () => {
	const { resolvePublicMeetingKey } = await import(
		"#/server/meeting-resolve-logic"
	);
	return {
		getPublicMeetingByKey: async ({
			data,
		}: {
			data: { clubId: string; key: string };
		}) => {
			const id = await resolvePublicMeetingKey(data.clubId, data.key);
			if (!id) throw new Error("Meeting not found.");
			return { meeting: { id } };
		},
	};
});
vi.mock("#/server/personal-meeting", () => ({
	getPublicPersonalMeetingView: vi.fn(),
}));
vi.mock("#/server/attendance-plan", () => ({}));
vi.mock("#/server/availability", () => ({}));

const { Route: RolesGuideRoute } = await import("./club.$clubId.roles-guide");
const { Route: MeRoute } = await import(
	"./club.$clubId.meeting.$meetingId_.me"
);

const TMOD = roleSeed("Toastmaster of the Day");

const seeds: SeededClub[] = [];
afterEach(async () => {
	rtlCleanup();
	vi.restoreAllMocks();
	for (const s of seeds.splice(0)) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

/** A club whose Toastmaster carries the default guide. */
async function clubWithGuide(): Promise<SeededClub> {
	const s = await seedClub();
	seeds.push(s);
	await testDb.insert(roleDefinitions).values({
		clubId: s.clubId,
		name: TMOD.name,
		key: TMOD.key,
		category: "leadership",
		beforeNotes: TMOD.beforeNotes,
		duringNotes: TMOD.duringNotes,
	});
	return s;
}

async function archive(clubId: string) {
	await testDb
		.update(clubs)
		.set({ archivedAt: new Date() })
		.where(eq(clubs.id, clubId));
}

// biome-ignore lint/suspicious/noExplicitAny: loaders take the full router ctx
type AnyLoader = (ctx: any) => Promise<any>;

function guideLoader(context: Record<string, unknown>) {
	return (RolesGuideRoute.options.loader as AnyLoader)({ context });
}

/** Render the roles guide's real component over `roles`; returns its HTML. */
async function renderGuide(roles: unknown): Promise<string> {
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
	const { container, unmount } = render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	const html = container.innerHTML;
	unmount();
	return html;
}

describe.skipIf(!hasTestDb)("roles guide page (#933)", () => {
	it("serves the guide for a live club and none once it is archived", async () => {
		const s = await clubWithGuide();
		const firstStep = TMOD.beforeNotes.split("\n")[0] ?? "";

		const live = await guideLoader({ clubUuid: s.clubId });
		const liveHtml = await renderGuide(live);
		expect(liveHtml).toContain('id="toastmaster-of-the-day"');
		expect(liveHtml).toContain(firstStep);

		await archive(s.clubId);
		const archived = await guideLoader({ clubUuid: s.clubId });
		expect(archived).toEqual([]);
		const archivedHtml = await renderGuide(archived);
		expect(archivedHtml).toContain("hasn't set up its meeting roles yet");
		expect(archivedHtml).not.toContain(firstStep);
		expect(archivedHtml).not.toContain("Before the meeting");
	});

	it("is the same page signed out as for another club's member", async () => {
		const s = await clubWithGuide();
		const other = await seedClub();
		seeds.push(other);

		// The loader takes no session: whatever the shell puts beside the club,
		// the data and the page are identical.
		const signedOut = await guideLoader({
			clubUuid: s.clubId,
			hasSession: false,
		});
		const otherMember = await guideLoader({
			clubUuid: s.clubId,
			hasSession: true,
			shell: true,
			currentUserId: other.memberUserId,
		});
		expect(otherMember).toEqual(signedOut);
		expect(await renderGuide(otherMember)).toBe(await renderGuide(signedOut));
		// And it is THIS club's guide, not the viewer's own club's.
		expect(
			(signedOut as { key?: string | null }[]).some((r) => r.key === TMOD.key),
		).toBe(true);
	});
});

describe.skipIf(!hasTestDb)("personal meeting page loader (#933)", () => {
	function meLoader(s: SeededClub) {
		return (MeRoute.options.loader as AnyLoader)({
			params: { clubId: "harbor-city", meetingId: s.meetingId },
			context: { clubUuid: s.clubId, hasSession: false },
		});
	}

	it("carries the club's guide for a live club, and is not-found with no guide once archived", async () => {
		const s = await clubWithGuide();
		const live = await meLoader(s);
		expect(
			live.roleGuides.find((r: { key?: string | null }) => r.key === TMOD.key),
		).toMatchObject({ beforeNotes: TMOD.beforeNotes });

		await archive(s.clubId);
		let thrown: unknown = null;
		let result: unknown;
		try {
			result = await meLoader(s);
		} catch (err) {
			thrown = err;
		}
		expect(result).toBeUndefined();
		expect(isNotFound(thrown)).toBe(true);
	});
});

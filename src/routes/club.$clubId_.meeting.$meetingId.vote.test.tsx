// @vitest-environment jsdom
//
// The ballot ROUTE's loader (#510).
//
// This exists because the bug it guards was found in PRODUCTION, not by the
// suite: a mistyped meeting key returned a 500 error boundary here while the
// sibling public routes (`present`, `word`) returned a proper 404. The ballot
// URL is the one printed on a QR code and handed to a room full of people, so
// a stale or mistyped key is the EXPECTED case, not the exotic one — this is
// the surface where the translation matters most, and it was the only one
// missing it.
//
// Follows the loader-test pattern established by
// `club.$clubId_.meeting.$meetingId.word.test.tsx`: mock the route's server-fn
// and club-resolver imports (all reach `#/db` → `pg`, which must not load in a
// unit test), then call `Route.options.loader` directly.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	isNotFound,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/voting", () => ({
	joinBallot: vi.fn(),
	getBallot: vi.fn(),
	submitVote: vi.fn(),
}));
// Reached transitively through `PickNameForm`, which the route renders.
vi.mock("#/server/members", () => ({
	listMembers: vi.fn(),
}));

import { resolveClubOrRedirect } from "#/lib/club-route";
import { getPublicMeetingByKey } from "#/server/meetings";
import { Route } from "./club.$clubId_.meeting.$meetingId.vote";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const location = { href: "/club/downtown/meeting/2026-01-01/vote" };

// biome-ignore lint/suspicious/noExplicitAny: route loaders take a router ctx
function runLoader(ctx: unknown): Promise<any> {
	// biome-ignore lint/suspicious/noExplicitAny: loader union has no call sig
	return (Route.options as any).loader(ctx);
}

function mockClub() {
	vi.mocked(resolveClubOrRedirect).mockResolvedValue({
		id: CLUB_ID,
		slug: "downtown",
		name: "Downtown Toastmasters",
		clubNumber: "123456",
		// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
	} as any);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("ballot route loader (#510)", () => {
	// The production bug, pinned. Asserted through `isMeetingNotFoundError`'s
	// real input — the thrown Error's message — so a change to that wording
	// fails here rather than silently reverting to a 500.
	it("404s when the meeting key does not exist, instead of 500ing", async () => {
		mockClub();
		vi.mocked(getPublicMeetingByKey).mockRejectedValue(
			new Error("Meeting not found."),
		);

		await expect(
			runLoader({
				params: { clubId: "downtown", meetingId: "2026-01-01" },
				location,
			}),
		).rejects.toSatisfy(isNotFound);
	});

	// ...but ONLY that error. A real failure must still reach the error
	// boundary rather than being disguised as a missing page — otherwise an
	// outage during a meeting reads to the room as "wrong link".
	it("propagates a non-not-found failure rather than masking it as a 404", async () => {
		mockClub();
		const boom = new Error("connection terminated");
		vi.mocked(getPublicMeetingByKey).mockRejectedValue(boom);

		await expect(
			runLoader({
				params: { clubId: "downtown", meetingId: "2026-01-01" },
				location,
			}),
		).rejects.toBe(boom);
	});

	// The cross-club guard: a meeting that resolves but belongs to another club
	// must not render a ballot under this club's name.
	it("404s when the meeting belongs to a different club", async () => {
		mockClub();
		vi.mocked(getPublicMeetingByKey).mockResolvedValue({
			meeting: {
				id: MEETING_ID,
				clubId: "99999999-9999-4999-8999-999999999999",
			},
			// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough
		} as any);

		await expect(
			runLoader({
				params: { clubId: "downtown", meetingId: "2026-01-01" },
				location,
			}),
		).rejects.toSatisfy(isNotFound);
	});

	it("returns the club and meeting the ballot needs on the happy path", async () => {
		mockClub();
		vi.mocked(getPublicMeetingByKey).mockResolvedValue({
			meeting: { id: MEETING_ID, clubId: CLUB_ID },
			// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough
		} as any);

		await expect(
			runLoader({
				params: { clubId: "downtown", meetingId: "2026-01-01" },
				location,
			}),
		).resolves.toMatchObject({
			clubId: CLUB_ID,
			clubName: "Downtown Toastmasters",
			meetingId: MEETING_ID,
		});
	});
});

describe("ballot route loader — digital voting switch (#770)", () => {
	for (const digitalVoting of [true, false]) {
		it(`passes digitalVoting=${digitalVoting} through for the page to branch on`, async () => {
			mockClub();
			vi.mocked(getPublicMeetingByKey).mockResolvedValue({
				meeting: { id: MEETING_ID, clubId: CLUB_ID },
				digitalVoting,
				// biome-ignore lint/suspicious/noExplicitAny: partial detail is enough
			} as any);

			await expect(
				runLoader({
					params: { clubId: "downtown", meetingId: "2026-01-01" },
					location,
				}),
			).resolves.toMatchObject({ digitalVoting });
		});
	}
});

/** Render the ballot PAGE (not just its loader) with a stubbed payload. */
async function renderVotePage(digitalVoting: boolean) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		clubId: CLUB_ID,
		clubName: "Downtown Toastmasters",
		clubNumber: "123456",
		meetingId: MEETING_ID,
		digitalVoting,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>
				<Component />
			</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("ballot page — digital voting off (#770)", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it("says so and offers NO way to identify yourself", async () => {
		await renderVotePage(false);

		expect(
			screen.getByText("Digital voting is off for this meeting"),
		).toBeTruthy();
		// The name picker and the guest-name field are the two ways in; neither
		// may be reachable, or a voter starts a flow that cannot end in a vote.
		expect(screen.queryByText(/Who are you/i)).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(screen.queryByRole("button", { name: /join|vote/i })).toBeNull();
	});

	it("shows the picker when digital voting is on — the control case", async () => {
		await renderVotePage(true);

		expect(
			screen.queryByText("Digital voting is off for this meeting"),
		).toBeNull();
		expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
	});
});

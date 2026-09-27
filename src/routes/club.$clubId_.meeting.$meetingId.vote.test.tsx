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
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// The session (#962). The page reads it on the client — never in the loader —
// so both halves are mocked here: Better Auth's hook, and the server fns the
// page calls only once that hook reports a signed-in user.
vi.mock("#/lib/auth-client", () => ({
	authClient: { useSession: vi.fn() },
}));
vi.mock("#/server/auth-context", () => ({
	getAuthContext: vi.fn(),
	setActiveClub: vi.fn(),
}));

import { authClient } from "#/lib/auth-client";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { getAuthContext, setActiveClub } from "#/server/auth-context";
import { getPublicMeetingByKey } from "#/server/meetings";
import { getBallot, submitVote } from "#/server/voting";
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

/** What `authClient.useSession()` reports. */
function mockSession(
	state: "pending" | "signedOut" | { userId: string },
): void {
	vi.mocked(authClient.useSession).mockReturnValue(
		(state === "pending"
			? { data: null, isPending: true }
			: state === "signedOut"
				? { data: null, isPending: false }
				: {
						data: { user: { id: state.userId } },
						isPending: false,
						// biome-ignore lint/suspicious/noExplicitAny: partial hook return
					}) as any,
	);
}

beforeEach(() => {
	// The signed-out default, so the loader and #770 suites below render the
	// page they always have. Re-set per test: `vi.restoreAllMocks` in their
	// `afterEach` does not reliably keep a factory mock's return value.
	mockSession("signedOut");
});

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

// #962. A signed-in member was asked "Who are you?" because the page chose its
// voter from the two localStorage stores and never looked at the session.
describe("ballot page — who the phone votes as (#962)", () => {
	const USER_ID = "user-1";
	const SESSION_MEMBER = "33333333-3333-4333-8333-333333333333";
	const PICKED_MEMBER = "44444444-4444-4444-8444-444444444444";
	const OTHER_CLUB = "55555555-5555-4555-8555-555555555555";

	/** `getAuthContext`'s answer for a member of the viewed club (or not). */
	function authCtx(over: {
		clubs?: string[];
		activeClubId?: string | null;
		currentMemberId?: string | null;
	}) {
		const clubs = over.clubs ?? [CLUB_ID];
		return {
			user: { id: USER_ID, name: "Sally Session", email: "sally@example.com" },
			clubs: clubs.map((clubId) => ({ clubId })),
			activeClubId: over.activeClubId ?? clubs[0] ?? null,
			currentMemberId:
				over.currentMemberId === undefined
					? SESSION_MEMBER
					: over.currentMemberId,
			// biome-ignore lint/suspicious/noExplicitAny: partial server payload
		} as any;
	}

	/** One open category with one candidate, so a cast is observable. */
	function openBallot() {
		const closed = { isOpen: false, hasOpened: false, candidates: [] };
		vi.mocked(getBallot).mockResolvedValue({
			meetingId: MEETING_ID,
			categories: {
				best_speaker: {
					isOpen: true,
					hasOpened: true,
					candidates: [
						{
							kind: "member",
							id: "c-1",
							name: "Alex Speaker",
							disqualified: null,
						},
					],
				},
				best_evaluator: closed,
				best_table_topics: closed,
			},
			digitalVotingOff: false,
			// biome-ignore lint/suspicious/noExplicitAny: server fn mock shape
		} as any);
		// biome-ignore lint/suspicious/noExplicitAny: server fn mock shape
		vi.mocked(submitVote).mockResolvedValue({ ok: true } as any);
	}

	/** A name picked earlier on the public club page, on this device. */
	function storePickedName() {
		localStorage.setItem(
			`gavelup:member:${CLUB_ID}`,
			JSON.stringify({ id: PICKED_MEMBER, name: "Pat Picked" }),
		);
	}

	/** Tap the one candidate and return the voter the cast was sent as. */
	async function castAndReadVoter() {
		fireEvent.click(
			await screen.findByRole("button", { name: "Alex Speaker" }),
		);
		await waitFor(() => expect(submitVote).toHaveBeenCalled());
		// biome-ignore lint/suspicious/noExplicitAny: server fn call shape
		return (vi.mocked(submitVote).mock.calls[0][0] as any).data.voter;
	}

	beforeEach(() => {
		vi.mocked(getAuthContext).mockReset();
		vi.mocked(setActiveClub).mockReset();
		vi.mocked(getBallot).mockReset();
		vi.mocked(submitVote).mockReset();
	});

	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	it("a signed-in member of the club sees the ballot, not the picker, and votes as their session member", async () => {
		mockSession({ userId: USER_ID });
		vi.mocked(getAuthContext).mockResolvedValue(authCtx({}));
		openBallot();
		// A DIFFERENT name picked on this device earlier: the session must win.
		storePickedName();

		await renderVotePage(true);

		expect(await screen.findByText("Best Speaker")).toBeTruthy();
		expect(screen.queryByText(/Who are you/i)).toBeNull();
		expect(screen.getByText("Voting as Sally Session")).toBeTruthy();
		// No re-pick: a signed-in phone cannot switch to voting as someone else.
		expect(screen.queryByText(/not you/i)).toBeNull();
		expect(await castAndReadVoter()).toEqual({
			kind: "member",
			id: SESSION_MEMBER,
		});
		// The session identity is not written over the device's stores, so the
		// pick underneath resurfaces on sign-out.
		expect(localStorage.getItem(`gavelup:voter:${MEETING_ID}`)).toBeNull();
	});

	it("a member whose active club is another one is switched to this club first, then votes as themselves", async () => {
		mockSession({ userId: USER_ID });
		vi.mocked(getAuthContext)
			.mockResolvedValueOnce(
				authCtx({ clubs: [OTHER_CLUB, CLUB_ID], activeClubId: OTHER_CLUB }),
			)
			.mockResolvedValue(
				authCtx({ clubs: [OTHER_CLUB, CLUB_ID], activeClubId: CLUB_ID }),
			);
		// biome-ignore lint/suspicious/noExplicitAny: server fn mock shape
		vi.mocked(setActiveClub).mockResolvedValue({ ok: true } as any);
		openBallot();

		await renderVotePage(true);

		expect(await screen.findByText("Best Speaker")).toBeTruthy();
		expect(setActiveClub).toHaveBeenCalledWith({ data: { clubId: CLUB_ID } });
		expect(screen.queryByText(/Who are you/i)).toBeNull();
		expect((await castAndReadVoter()).id).toBe(SESSION_MEMBER);
	});

	it("a signed-in user who is NOT a member of this club gets today's signed-out picker", async () => {
		mockSession({ userId: USER_ID });
		vi.mocked(getAuthContext).mockResolvedValue(
			authCtx({ clubs: [OTHER_CLUB], currentMemberId: "not-this-club" }),
		);

		await renderVotePage(true);

		expect(await screen.findByText("Who are you?")).toBeTruthy();
		expect(getAuthContext).toHaveBeenCalled();
		// Their other club must not be switched to, or to this one they are not in.
		expect(setActiveClub).not.toHaveBeenCalled();
	});

	it("a signed-in non-member with a picked name votes as the pick, exactly as signed out", async () => {
		mockSession({ userId: USER_ID });
		vi.mocked(getAuthContext).mockResolvedValue(
			authCtx({ clubs: [OTHER_CLUB] }),
		);
		openBallot();
		storePickedName();

		await renderVotePage(true);

		expect(
			await screen.findByText("Voting as Pat Picked — not you?"),
		).toBeTruthy();
		expect((await castAndReadVoter()).id).toBe(PICKED_MEMBER);
	});

	it("signed out: shows the picker and never asks the server who the phone is", async () => {
		mockSession("signedOut");

		await renderVotePage(true);

		expect(screen.getByText("Who are you?")).toBeTruthy();
		expect(getAuthContext).not.toHaveBeenCalled();
	});

	it("signed out: a guest with a stored voter for this meeting votes as that guest", async () => {
		mockSession("signedOut");
		openBallot();
		localStorage.setItem(
			`gavelup:voter:${MEETING_ID}`,
			JSON.stringify({ kind: "guest", id: "g-9", name: "Visitor Vic" }),
		);

		await renderVotePage(true);

		expect(
			await screen.findByText("Voting as Visitor Vic — not you?"),
		).toBeTruthy();
		expect(await castAndReadVoter()).toEqual({ kind: "guest", id: "g-9" });
		expect(getAuthContext).not.toHaveBeenCalled();
	});

	it("does not flash the picker while the session is still loading", async () => {
		mockSession("pending");
		storePickedName();

		await renderVotePage(true);

		expect(screen.getByText("Loading your ballot…")).toBeTruthy();
		expect(screen.queryByText(/Who are you/i)).toBeNull();
		// Nor the stored pick's ballot: the session might disagree with it.
		expect(screen.queryByText(/Voting as/)).toBeNull();
	});

	it("does not flash the picker while a signed-in member is being resolved", async () => {
		mockSession({ userId: USER_ID });
		vi.mocked(getAuthContext).mockReturnValue(new Promise(() => {}));

		await renderVotePage(true);

		expect(screen.getByText("Loading your ballot…")).toBeTruthy();
		expect(screen.queryByText(/Who are you/i)).toBeNull();
	});

	it("falls back to the signed-out picker when the session cannot be resolved", async () => {
		mockSession({ userId: USER_ID });
		vi.mocked(getAuthContext).mockRejectedValue(new Error("offline"));

		await renderVotePage(true);

		expect(await screen.findByText("Who are you?")).toBeTruthy();
	});
});

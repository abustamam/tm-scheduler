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
import { isNotFound } from "@tanstack/react-router";
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

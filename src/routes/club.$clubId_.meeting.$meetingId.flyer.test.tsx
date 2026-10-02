// @vitest-environment jsdom
//
// The public flyer route (#931) marks a cancelled meeting (#1057), from the
// flyer's OWN payload: the loader reads `cancelled` off the meeting the flyer
// reader served, carried through `FLYER_MEETING_FIELDS`, and asks nothing
// else. A second lookup is what this replaced: it failed OPEN, so a cancelled
// meeting printed as a live invitation whenever that lookup failed.
//
// Same harness as the word route's test: the server fn and the club resolver
// are mocked (both reach `#/db` → `pg`).
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/promo", () => ({ getPublicFlyer: vi.fn() }));
// Not imported by the route. Mocked so that re-adding a second status lookup
// fails the "asks nothing else" case below instead of loading `pg`.
vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));

import { resolveClubOrRedirect } from "#/lib/club-route";
import {
	DEFAULT_PROMO_TEMPLATE,
	type FlyerMeetingStatus,
} from "#/lib/promo-template";
import { getPublicMeetingByKey } from "#/server/meetings";
import { getPublicFlyer } from "#/server/promo";
import { Route } from "./club.$clubId_.meeting.$meetingId.flyer";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const params = { clubId: "downtown", meetingId: "2026-10-01" };
const location = { href: "/club/downtown/meeting/2026-10-01/flyer" };

const CLUB = {
	name: "Downtown Speakers",
	slug: "downtown",
	timezone: "America/Chicago",
};

const meeting = (status: FlyerMeetingStatus) => ({
	id: MEETING_ID,
	urlKey: "2026-10-01",
	scheduledAt: "2026-10-02T00:30:00Z",
	location: "Library",
	online: false,
	theme: "Beginnings",
	wordOfTheDay: null,
	meetingNumber: 57,
	promoNote: null,
	status,
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

// biome-ignore lint/suspicious/noExplicitAny: route loaders take a router ctx
function runLoader(): Promise<any> {
	// biome-ignore lint/suspicious/noExplicitAny: loader union has no call sig
	return (Route.options as any).loader({ params, location });
}

function mockFlyer(status: FlyerMeetingStatus) {
	vi.mocked(resolveClubOrRedirect).mockResolvedValue({
		id: CLUB_ID,
		// biome-ignore lint/suspicious/noExplicitAny: partial club row
	} as any);
	vi.mocked(getPublicFlyer).mockResolvedValue({
		club: CLUB,
		template: DEFAULT_PROMO_TEMPLATE,
		meeting: meeting(status),
		logoUrl: null,
	});
}

describe("flyer loader marks a cancelled meeting off its own payload (#1057)", () => {
	it("a cancelled meeting's flyer is marked, with no second lookup", async () => {
		mockFlyer("cancelled");
		const result = await runLoader();
		expect(result.cancelled).toBe(true);
		// Carried through the allowlist, so the page holds what it was marked by.
		expect(result.meeting.status).toBe("cancelled");
		expect(getPublicFlyer).toHaveBeenCalledTimes(1);
		expect(getPublicMeetingByKey).not.toHaveBeenCalled();
	});

	it("a live meeting's flyer is not (control)", async () => {
		for (const status of ["scheduled", "completed"] as const) {
			mockFlyer(status);
			expect((await runLoader()).cancelled).toBe(false);
		}
	});
});

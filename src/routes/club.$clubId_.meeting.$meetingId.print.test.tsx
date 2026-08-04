// @vitest-environment jsdom
//
// #495 — the print route's LOADER wiring had zero test coverage before this
// file (the route itself had no test file at all, and `clubLogoUrl` — the
// only thing that turns `logoMeta` into `header.logoUrl` — is mocked away at
// the one other real call site, `club-settings.test.tsx`). This is narrowly
// scoped to the loader (not the rendered component, which needs a much larger
// fixture for `buildTimeline`/`buildRosterEntries`/etc.), following the
// pattern in `club.$clubId_.meeting.$meetingId.word.test.tsx`: call
// `Route.options.loader` directly with mocked server-fn/resolver imports.
//
// `#/lib/club-logo-url` is deliberately NOT mocked — using the real
// `clubLogoUrl` here is what actually proves the loader threads the resolved
// club id and the logo's `updatedAt` into it correctly, since the other call
// site can't (it mocks that function away).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/club-logo", () => ({ getClubLogoMeta: vi.fn() }));

import { resolveClubOrRedirect } from "#/lib/club-route";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";
import { Route } from "./club.$clubId_.meeting.$meetingId.print";

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

/** The public-meeting payload shape the loader reads `meeting.clubId` off of
 *  and otherwise passes through untouched. */
function meetingData(clubId: string = CLUB_ID) {
	return {
		meeting: {
			clubId,
			scheduledAt: "2026-07-31T18:45:00Z",
			lengthMinutes: 60,
			theme: null,
			wordOfTheDay: null,
			location: null,
			reminders: null,
		},
		slots: [],
		timezone: "UTC",
		clubName: "Downtown Toastmasters",
		clubNumber: null,
		clubDistrict: null,
		clubMission: null,
		clubMeetingSchedule: null,
		meetingNumber: null,
		officers: [],
		geIntroducesFunctionaries: false,
	};
}

const location = {
	pathname: "/club/downtown/meeting/2026-07-31/print",
	searchStr: "",
};
// biome-ignore lint/suspicious/noExplicitAny: loader takes the full router ctx
const runLoader = (ctx: any) => (Route.options.loader as any)(ctx);

describe("Print agenda route — loader logo wiring (#495)", () => {
	it("returns a null logoUrl when the club has no logo", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(meetingData() as any);
		vi.mocked(getClubLogoMeta).mockResolvedValue(null);

		const result = await runLoader({
			params: { clubId: "downtown", meetingId: "2026-07-31" },
			location,
		});

		expect(result.logoUrl).toBeNull();
	});

	it("builds the versioned logo URL from the RESOLVED club id and the logo's real updatedAt, through the real clubLogoUrl", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(meetingData() as any);
		const updatedAt = "2026-07-31T00:00:00.000Z";
		vi.mocked(getClubLogoMeta).mockResolvedValue({ updatedAt });

		const result = await runLoader({
			params: { clubId: "downtown", meetingId: "2026-07-31" },
			location,
		});

		expect(result.logoUrl).toBe(
			`/api/club/${CLUB_ID}/logo?v=${new Date(updatedAt).getTime()}`,
		);
	});

	// The resolved id, not the raw URL segment — the segment may be a club
	// number, slug, or UUID, and only `resolveClubOrRedirect`'s output is the
	// real club id `club_logos` is keyed on.
	it("fetches the logo meta for the RESOLVED club id, not the raw URL param", async () => {
		vi.mocked(resolveClubOrRedirect).mockResolvedValue({
			id: CLUB_ID,
			// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
		} as any);
		// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
		vi.mocked(getPublicMeetingByKey).mockResolvedValue(meetingData() as any);
		vi.mocked(getClubLogoMeta).mockResolvedValue(null);

		await runLoader({
			params: { clubId: "downtown", meetingId: "2026-07-31" },
			location,
		});

		expect(getClubLogoMeta).toHaveBeenCalledWith({ data: { clubId: CLUB_ID } });
	});
});

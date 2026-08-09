/**
 * The loader → `logoUrl` seam (#496).
 *
 * Every component that renders a club logo is tested with a `logoUrl` the TEST
 * injects. Nothing tested who SUPPLIES it. A ship-time coverage audit forced
 * all four route loaders to return `logoUrl: null` at once and the entire
 * 2871-test suite stayed green — the feature could have shipped rendering no
 * logo on four of five surfaces with CI passing.
 *
 * These close that seam for the two standalone public print routes. They follow
 * the pattern documented in `club.$clubId_.meeting.$meetingId.word.test.tsx`:
 * mock the route's server-fn and club-resolver imports (all of which reach
 * `#/db` → `pg`, which must not load here), then call `Route.options.loader`
 * directly — it is a plain function.
 *
 * `clubLogoUrl` is deliberately NOT mocked: the versioned `?v=<epochMs>` shape
 * is the contract the service worker depends on, so the assertion is on the
 * real string, not on "the builder was called".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/club-logo", () => ({ getClubLogoMeta: vi.fn() }));
vi.mock("#/server/role-definitions", () => ({ getPublicClubRoles: vi.fn() }));
vi.mock("#/server/meetings", () => ({ getPublicMeetingByKey: vi.fn() }));
// The present route's component tree now reaches `getVoteParticipation`
// (#510, the projector's participation badge) — never called from this
// loader-only suite, but importing the route module still eagerly imports
// `MeetingPresent`, which imports this, which reaches `#/db` → `pg` at
// module load time just like the four mocks above.
vi.mock("#/server/voting", () => ({ getVoteParticipation: vi.fn() }));

import { resolveClubOrRedirect } from "#/lib/club-route";
import { getClubLogoMeta } from "#/server/club-logo";
import { getPublicMeetingByKey } from "#/server/meetings";
import { getPublicClubRoles } from "#/server/role-definitions";
import { Route as PresentRoute } from "./club.$clubId_.meeting.$meetingId.present";
import { Route as RolesRoute } from "./club.$clubId_.roles";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const UPDATED_AT = new Date("2026-08-04T12:00:00Z");
const ISO = UPDATED_AT.toISOString();
const EXPECTED = `/api/club/${CLUB_ID}/logo?v=${UPDATED_AT.getTime()}`;

// biome-ignore lint/suspicious/noExplicitAny: route loaders take a router ctx
const ctx = (clubId = CLUB_ID, meetingId = "2026-08-13"): any => ({
	params: { clubId, meetingId },
	location: { href: "/" },
});

/**
 * `Route.options.loader` is typed as a union whose object variant carries no
 * call signature, so TypeScript refuses a direct call even though every route
 * here defines the function form. Narrow it once rather than casting at each
 * of the eight call sites.
 */
// biome-ignore lint/suspicious/noExplicitAny: narrowing a TanStack union
function runLoader(route: { options: { loader?: any } }, c: unknown) {
	return route.options.loader(c) as Promise<{
		logoUrl: string | null;
		roles?: unknown;
		clubName?: string;
	}>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolveClubOrRedirect).mockResolvedValue({
		id: CLUB_ID,
		name: "Downtown Toastmasters",
		// biome-ignore lint/suspicious/noExplicitAny: partial club is enough here
	} as any);
	vi.mocked(getPublicClubRoles).mockResolvedValue([]);
	vi.mocked(getPublicMeetingByKey).mockResolvedValue({
		meeting: { clubId: CLUB_ID },
		clubName: "Downtown Toastmasters",
		clubNumber: "1234567",
		clubDistrict: "District 39",
		timezone: "America/Chicago",
		clubMeetingSchedule: "2nd & 4th Thursday",
		slots: [],
		nextMeetingAt: null,
		meetingNumber: 12,
		geIntroducesFunctionaries: false,
		// biome-ignore lint/suspicious/noExplicitAny: partial payload is enough
	} as any);
});

describe("public role-sheet route supplies the club logo (#496)", () => {
	it("builds the versioned logo URL when the club has a logo", async () => {
		vi.mocked(getClubLogoMeta).mockResolvedValue({ updatedAt: ISO });
		const data = await runLoader(RolesRoute, ctx());
		expect(data?.logoUrl).toBe(EXPECTED);
	});

	it("passes null when the club has no logo", async () => {
		vi.mocked(getClubLogoMeta).mockResolvedValue(null);
		const data = await runLoader(RolesRoute, ctx());
		expect(data?.logoUrl).toBeNull();
	});

	it("reads the logo for the RESOLVED club, not the raw URL param", async () => {
		// The param may be a slug; the logo must be scoped to the club the
		// resolver returned (ADR-0024 constraint 2).
		vi.mocked(getClubLogoMeta).mockResolvedValue({ updatedAt: ISO });
		await runLoader(RolesRoute, ctx("downtown-toastmasters"));
		expect(getClubLogoMeta).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID },
		});
	});

	it("still renders the sheet when the logo lookup fails", async () => {
		// Decorative: a logo failure must never cost someone the page.
		vi.mocked(getClubLogoMeta).mockRejectedValue(new Error("db down"));
		const data = await runLoader(RolesRoute, ctx());
		expect(data?.logoUrl).toBeNull();
		expect(data?.roles).toEqual([]);
	});
});

describe("present-mode route supplies the club logo (#496)", () => {
	it("builds the versioned logo URL when the club has a logo", async () => {
		vi.mocked(getClubLogoMeta).mockResolvedValue({ updatedAt: ISO });
		const data = await runLoader(PresentRoute, ctx());
		expect(data?.logoUrl).toBe(EXPECTED);
	});

	it("passes null when the club has no logo", async () => {
		vi.mocked(getClubLogoMeta).mockResolvedValue(null);
		const data = await runLoader(PresentRoute, ctx());
		expect(data?.logoUrl).toBeNull();
	});

	it("still renders the deck when the logo lookup fails", async () => {
		vi.mocked(getClubLogoMeta).mockRejectedValue(new Error("db down"));
		const data = await runLoader(PresentRoute, ctx());
		expect(data?.logoUrl).toBeNull();
		expect(data?.clubName).toBe("Downtown Toastmasters");
	});

	it("accepts a Date as well as the serialized string from the wire", async () => {
		// `getClubLogoMeta` is typed as returning a STRING, because a server fn
		// serializes Dates over the wire — but the same builder is called with a
		// real Date on paths that never cross that boundary. Both must produce
		// the same cache-buster, or the two would disagree on the SW cache key.
		vi.mocked(getClubLogoMeta).mockResolvedValue({
			// biome-ignore lint/suspicious/noExplicitAny: exercising the non-wire shape
			updatedAt: UPDATED_AT as any,
		});
		const data = await runLoader(PresentRoute, ctx());
		expect(data?.logoUrl).toBe(EXPECTED);
	});
});

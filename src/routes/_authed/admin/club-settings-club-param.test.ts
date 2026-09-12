/**
 * `/admin/club-settings`'s club resolution: the `?club=` parameter and the
 * guard that validates it (#685).
 *
 * ## Why this file exists next to `club-settings.test.tsx`
 *
 * That file is a jsdom component suite for the logo section; it stubs
 * `Route.useRouteContext` and never runs a guard. The three lines that decide
 * WHICH CLUB the page is about are only reachable through
 * `Route.options.beforeLoad`, and they are the whole of #685. Same shape as
 * `officers.test.ts`, which is the only other place a `beforeLoad` is exercised
 * directly here.
 *
 * ## What is actually being pinned
 *
 * The bug: the agenda editor is URL-scoped (`/club/$clubId/…`) and this route
 * was context-scoped, so a multi-club admin editing club B's agenda while their
 * active club was A followed the editor's "Club settings" link into A's
 * settings — and changing the Table Topics window there left the agenda they
 * came from untouched, reading as "the setting did nothing".
 *
 * The three assertions that carry it, in order of what breaks if they go:
 *
 * 1. An explicit club WINS over the active club. Without this the fix is absent.
 * 2. A club the viewer has no rights on is REFUSED, and specifically not
 *    swapped for their context-resolved club. A silent swap would look like a
 *    passing fix while reinstating the bug in a form the officer cannot see —
 *    they would again land on some other club's settings, now trusting the link.
 * 3. With NO parameter, resolution is byte-for-byte today's. The app-shell nav
 *    item and the command palette both link here with no club in hand.
 *
 * ## Not the authorization boundary, and the test must not imply it is
 *
 * Every read and write the page makes re-runs `requireClubRole(userId, clubId,
 * ["admin"])` server-side, per club (`club-settings-authz.guard.test.ts` pins
 * the write half). This guard decides which page a viewer is OFFERED. That is
 * why the office arm may stay permissive for a non-active club — see the
 * docblock on `effectiveAdminClubFor`.
 */
import { describe, expect, it, vi } from "vitest";

// The route module's server-fn imports reach `#/db` → `pg` at import time
// ("DATABASE_URL is not set" in a unit context). The guard under test calls
// none of them — only the loader does, and the loader never runs here.
vi.mock("#/server/clubs", () => ({
	getClubProfileSettings: vi.fn(),
	loadClubAgendaSettings: vi.fn(),
	loadClubTimezoneSettings: vi.fn(),
	updateClubAgendaSettings: vi.fn(),
	updateClubProfile: vi.fn(),
	updateClubTimezone: vi.fn(),
}));
vi.mock("#/server/notification-prefs", () => ({
	loadClubReminderSettings: vi.fn(),
	updateClubReminderSettings: vi.fn(),
}));
vi.mock("#/server/club-logo", () => ({
	getClubLogoMeta: vi.fn(),
	uploadClubLogo: vi.fn(),
	removeClubLogoFn: vi.fn(),
}));

import type { OfficerPosition } from "#/lib/officers";
import { Route } from "./club-settings";

const CLUB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLUB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function club(clubId: string, clubRole: "admin" | "member", name: string) {
	return { clubId, name, clubNumber: null, clubRole };
}

/** The `_authed` shell's context, narrowed to what the guard reads. */
function guardContext(over: {
	clubs: ReturnType<typeof club>[];
	activeClubId: string | null;
	officerPositions?: OfficerPosition[];
}) {
	return {
		clubs: over.clubs,
		activeClubId: over.activeClubId,
		officerPositions: over.officerPositions ?? [],
	};
}

type GuardContext = ReturnType<typeof guardContext>;

function runBeforeLoad(context: GuardContext, search: { club?: string }) {
	const beforeLoad = Route.options.beforeLoad as unknown as (args: {
		context: GuardContext;
		search: { club?: string };
	}) => unknown;
	if (!beforeLoad) {
		throw new Error("club-settings lost its beforeLoad guard");
	}
	return beforeLoad({ context, search });
}

/** The club the guard resolved, or the `to` of the redirect it threw. */
function resolve(
	context: GuardContext,
	search: { club?: string },
): { clubId: string } | { redirectedTo: string } {
	try {
		const result = runBeforeLoad(context, search) as {
			adminClub: { clubId: string };
		};
		return { clubId: result.adminClub.clubId };
	} catch (thrown) {
		// TanStack's redirect() throws a Response carrying the nav options.
		expect(thrown).toBeInstanceOf(Response);
		const to = (thrown as Response & { options: { to?: string } }).options.to;
		return { redirectedTo: to ?? "(no `to`)" };
	}
}

/** Admin of both clubs, acting in A — the reporter's own situation. */
const MULTI_CLUB_ADMIN = guardContext({
	clubs: [club(CLUB_A, "admin", "Club A"), club(CLUB_B, "admin", "Club B")],
	activeClubId: CLUB_A,
});

describe("validateSearch", () => {
	const validateSearch = Route.options.validateSearch as unknown as (
		search: Record<string, unknown>,
	) => { club?: string };

	it("reads a string `club`", () => {
		expect(validateSearch({ club: CLUB_B })).toEqual({ club: CLUB_B });
	});

	it("drops a non-string `club` rather than passing it through", () => {
		// `?club=1&club=2` arrives as an array; a number or object can arrive from
		// a programmatic navigation. None of them may reach the lookup as-is.
		expect(validateSearch({ club: [CLUB_A, CLUB_B] })).toEqual({
			club: undefined,
		});
		expect(validateSearch({ club: 7 })).toEqual({ club: undefined });
	});

	it("defaults to no club, which is what the global nav links send", () => {
		expect(validateSearch({})).toEqual({ club: undefined });
	});
});

describe("beforeLoad club resolution (#685)", () => {
	it("shows the club the link NAMES, not the active one", () => {
		expect(resolve(MULTI_CLUB_ADMIN, { club: CLUB_B })).toEqual({
			clubId: CLUB_B,
		});
	});

	it("still shows the active club when the link names it", () => {
		expect(resolve(MULTI_CLUB_ADMIN, { club: CLUB_A })).toEqual({
			clubId: CLUB_A,
		});
	});

	it("with NO club, resolves from context exactly as before", () => {
		expect(resolve(MULTI_CLUB_ADMIN, {})).toEqual({ clubId: CLUB_A });
	});

	it("refuses a club the viewer is not in — no fallback to their own", () => {
		// The `redirectedTo` is the point: a `clubId` of CLUB_A here would be the
		// silent-swap failure, and it would read as a pass in any test that only
		// asserted "the page rendered".
		expect(resolve(MULTI_CLUB_ADMIN, { club: STRANGER })).toEqual({
			redirectedTo: "/dashboard",
		});
	});

	it("refuses a club the viewer is only a plain member of", () => {
		const context = guardContext({
			clubs: [
				club(CLUB_A, "admin", "Club A"),
				club(CLUB_B, "member", "Club B"),
			],
			activeClubId: CLUB_A,
		});
		expect(resolve(context, { club: CLUB_B })).toEqual({
			redirectedTo: "/dashboard",
		});
	});

	it("refuses a malformed id without a separate shape check", () => {
		expect(resolve(MULTI_CLUB_ADMIN, { club: "not-a-uuid" })).toEqual({
			redirectedTo: "/dashboard",
		});
	});

	it("admits an officer-by-office to the club the link names (#202)", () => {
		// A VPE of B, stored role `member` in both, workspace acting in A. This is
		// the case the fix is FOR: #202 exists because officers are typically not
		// stored admins, so refusing them here would make the fix useless to the
		// people it was written for.
		const context = guardContext({
			clubs: [
				club(CLUB_A, "member", "Club A"),
				club(CLUB_B, "member", "Club B"),
			],
			activeClubId: CLUB_A,
			officerPositions: ["vp_education"],
		});
		expect(resolve(context, { club: CLUB_B })).toEqual({ clubId: CLUB_B });
	});

	it("still bounces a plain member with no office, parameter or not", () => {
		const context = guardContext({
			clubs: [club(CLUB_A, "member", "Club A")],
			activeClubId: CLUB_A,
		});
		expect(resolve(context, {})).toEqual({ redirectedTo: "/dashboard" });
		expect(resolve(context, { club: CLUB_A })).toEqual({
			redirectedTo: "/dashboard",
		});
	});

	it("hands the loader and the component ONE resolution, in route context", () => {
		// The guard admitting one club while the loader fetched another is the
		// failure mode the single `adminClub` return exists to make unreachable.
		// The loader reads `context.adminClub.clubId` five times and the component
		// reads it again through `useRouteContext`; nothing recomputes it.
		const returned = runBeforeLoad(MULTI_CLUB_ADMIN, { club: CLUB_B });
		expect(returned).toEqual({
			adminClub: club(CLUB_B, "admin", "Club B"),
		});
	});
});

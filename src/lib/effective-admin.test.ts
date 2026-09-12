/**
 * The two effective-admin resolvers (#202, #685).
 *
 * `effectiveAdminClub` had no suite of its own — it was covered incidentally by
 * `officers.test.ts` through one route's guard. #685 added a second resolver
 * beside it, so the pair now needs a home where the question they answer
 * differently (which club) is separable from the question they must answer
 * identically (is this viewer an admin of it).
 *
 * The bug being pinned: `/admin/club-settings` resolves its club from workspace
 * context, the agenda editor that links to it is URL-scoped, and a multi-club
 * admin editing club B while their active club was A landed on A's settings.
 * The half that lives here is `effectiveAdminClubFor` selecting the club it is
 * NAMED and refusing — never substituting — when the viewer has no rights on it.
 */
import { describe, expect, it } from "vitest";
import { effectiveAdminClub, effectiveAdminClubFor } from "./effective-admin";
import type { OfficerPosition } from "./officers";

const CLUB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLUB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function club(clubId: string, clubRole: "admin" | "member", name: string) {
	return { clubId, name, clubNumber: null, clubRole };
}

/**
 * The shape `_authed`'s `beforeLoad` puts on route context. `officerPositions`
 * is deliberately a flat list of positions with no club on them — that is what
 * `getAuthContext` returns, and the fact that it describes the ACTIVE club only
 * is the constraint the second resolver's docblock is about.
 */
function ctx(over: {
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

describe("effectiveAdminClub (club in context) — unchanged by #685", () => {
	it("returns the active club when the viewer is a stored admin there", () => {
		const context = ctx({
			clubs: [club(CLUB_A, "member", "A"), club(CLUB_B, "admin", "B")],
			activeClubId: CLUB_B,
		});
		expect(effectiveAdminClub(context)?.clubId).toBe(CLUB_B);
	});

	it("returns the active club for an officer WITHOUT the stored admin role (#202)", () => {
		const context = ctx({
			clubs: [club(CLUB_A, "member", "A")],
			activeClubId: CLUB_A,
			officerPositions: ["vp_education"],
		});
		expect(effectiveAdminClub(context)?.clubId).toBe(CLUB_A);
	});

	it("returns undefined for a plain member holding no office", () => {
		const context = ctx({
			clubs: [club(CLUB_A, "member", "A")],
			activeClubId: CLUB_A,
		});
		expect(effectiveAdminClub(context)).toBeUndefined();
	});

	it("falls back to the first club when no active club is set", () => {
		const context = ctx({
			clubs: [club(CLUB_A, "admin", "A"), club(CLUB_B, "admin", "B")],
			activeClubId: null,
		});
		expect(effectiveAdminClub(context)?.clubId).toBe(CLUB_A);
	});

	it("returns undefined when the viewer is in no clubs", () => {
		expect(effectiveAdminClub(ctx({ clubs: [], activeClubId: null }))).toBe(
			undefined,
		);
	});
});

describe("effectiveAdminClubFor (club by id) — #685", () => {
	it("selects the NAMED club, not the active one — the whole bug", () => {
		// The reported case: admin of both, editing B's agenda, active club A.
		const context = ctx({
			clubs: [club(CLUB_A, "admin", "A"), club(CLUB_B, "admin", "B")],
			activeClubId: CLUB_A,
		});
		expect(effectiveAdminClub(context)?.clubId).toBe(CLUB_A);
		expect(effectiveAdminClubFor(context, CLUB_B)?.clubId).toBe(CLUB_B);
	});

	it("REFUSES a club the viewer is not in — and does not substitute their own", () => {
		// The acceptance criterion with teeth: a refusal must be `undefined`, not
		// a quiet swap for the context-resolved club, which would reinstate #685
		// in a form the officer cannot see.
		const context = ctx({
			clubs: [club(CLUB_A, "admin", "A")],
			activeClubId: CLUB_A,
		});
		expect(effectiveAdminClubFor(context, STRANGER)).toBeUndefined();
	});

	it("refuses a garbage id, and a SLUG, the same way", () => {
		// The slug case is the shipped regression of the first cut: the link read
		// `/club/$clubId`, which `resolveClubOrRedirect` has canonicalised to the
		// club's slug, and sent that. It matches no club here.
		const context = ctx({
			clubs: [club(CLUB_A, "admin", "A")],
			activeClubId: CLUB_A,
		});
		expect(
			effectiveAdminClubFor(context, "harbor-city-speakers"),
		).toBeUndefined();
		expect(effectiveAdminClubFor(context, "")).toBeUndefined();
	});

	it("refuses a club the viewer is only a plain member of", () => {
		const context = ctx({
			clubs: [club(CLUB_A, "admin", "A"), club(CLUB_B, "member", "B")],
			activeClubId: CLUB_A,
		});
		expect(effectiveAdminClubFor(context, CLUB_B)).toBeUndefined();
	});

	it("admits an officer-by-office for the ACTIVE club (#202)", () => {
		const context = ctx({
			clubs: [club(CLUB_A, "member", "A")],
			activeClubId: CLUB_A,
			officerPositions: ["vp_education"],
		});
		expect(effectiveAdminClubFor(context, CLUB_A)?.clubId).toBe(CLUB_A);
	});

	it("does NOT let an office in the active club vouch for a different club", () => {
		// The unsound arm, spelled out. `officerPositions` is resolved off the
		// ACTIVE club's membership id (`auth-context.ts`) and `OfficerPosition`
		// carries no club, so an officer of A says nothing about B. Reusing
		// `effectiveAdminClub`'s club-blind arm here would admit this viewer to
		// B's settings — and the four settings READS gate on
		// `requireClubViewAccess` (member-level), so B's real settings would
		// render rather than an error page.
		const context = ctx({
			clubs: [club(CLUB_A, "member", "A"), club(CLUB_B, "member", "B")],
			activeClubId: CLUB_A,
			officerPositions: ["vp_education"],
		});
		expect(effectiveAdminClubFor(context, CLUB_B)).toBeUndefined();
	});

	it("still admits a STORED admin of a non-active club", () => {
		// The narrowing above must not take the stored-admin arm with it: that arm
		// reads the club's own membership row, which is per-club and therefore
		// sound for any club in the list.
		const context = ctx({
			clubs: [club(CLUB_A, "member", "A"), club(CLUB_B, "admin", "B")],
			activeClubId: CLUB_A,
			officerPositions: [],
		});
		expect(effectiveAdminClubFor(context, CLUB_B)?.clubId).toBe(CLUB_B);
	});
});

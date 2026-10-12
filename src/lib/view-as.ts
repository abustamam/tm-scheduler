// "Preview as member" (#1113): an app-wide ROLE preview for someone with club
// authority. Pure + client-safe (no db), mirrors `active-club.ts`, so it is
// directly unit-testable and the cookie plumbing in `auth-context.ts` stays thin.
//
// It changes what is SHOWN, never what a write DOES. The only server files that
// may reference this module are listed in `view-as-allowlist.guard.test.ts`.

import type { OfficerPosition } from "./officers";

/** Cookie name persisting the preview across reloads and new tabs. */
export const VIEW_AS_COOKIE = "view_as";

export type ViewAs = "member";

/** `"member"` is the only value; anything else (absent, empty, forged) is no preview. */
export function parseViewAs(raw: string | null | undefined): ViewAs | null {
	return raw === "member" ? "member" : null;
}

interface ViewAsCtx {
	clubs: readonly {
		clubId: string;
		name: string;
		clubNumber: string | null;
		clubRole: "admin" | "member";
	}[];
	activeClubId: string | null;
	officerPositions: readonly OfficerPosition[];
}

/**
 * What the cookie does to the auth context. Honoured only when the viewer has
 * admin authority in ANY club: a stored `clubRole: "admin"` in one of `clubs`
 * (a superadmin session's club included), or an elected office in the active
 * club (`officerPositions` are resolved for it alone). Then EVERY club's
 * `clubRole` becomes `"member"`, `officerPositions` becomes `[]` and `viewAs` is
 * `"member"`.
 *
 * It downgrades every club, not just the active one, because the preview is per
 * browser and not per club (#1113, maintainer decision): `effectiveAdminClubFor`
 * answers for an EXPLICIT club id (`/admin/club-settings?club=B`), and a club the
 * viewer administers but is not acting in would otherwise still be granted in the
 * middle of the preview. For the same reason authority is read from any club, so
 * an admin of B whose active club is C (where they are a plain member) still gets
 * the banner instead of a preview that silently changes only some payloads.
 *
 * Otherwise (no preview, or nothing to drop: a plain member of every club who
 * set the cookie by hand) the context comes back unchanged with `viewAs: null`,
 * so there is no banner and no change.
 *
 * A superadmin's session is injected into `clubs` as `clubRole: "admin"` before
 * this runs, so it downgrades like a stored admin.
 */
export function applyViewAs<C extends ViewAsCtx>(
	ctx: C,
	viewAs: ViewAs | null,
): C & { viewAs: ViewAs | null } {
	const hasAuthority =
		ctx.clubs.some((c) => c.clubRole === "admin") ||
		ctx.officerPositions.length > 0;
	if (viewAs === null || !hasAuthority) return { ...ctx, viewAs: null };
	return {
		...ctx,
		clubs: ctx.clubs.map((c) => ({ ...c, clubRole: "member" as const })),
		officerPositions: [],
		viewAs,
	};
}

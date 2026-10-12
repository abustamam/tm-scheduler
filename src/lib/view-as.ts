// "Preview as member" (#1113): an app-wide ROLE preview for someone with club
// authority. Pure + client-safe (no db), mirrors `active-club.ts`, so it is
// directly unit-testable and the cookie plumbing in `auth-context.ts` stays thin.
//
// It changes what is SHOWN, never what a write DOES. The only server files that
// may reference this module are listed in `view-as-allowlist.guard.test.ts`.

import { effectiveAdminClub } from "./effective-admin";
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
 * What the cookie does to the auth context. Returns the context with
 * `viewAs: null` and nothing else changed when there is no preview OR the viewer
 * has no admin authority in the active club to drop (a plain member who sets the
 * cookie by hand sees no change and no banner). Otherwise the ACTIVE club's
 * `clubRole` becomes `"member"` (other clubs untouched), `officerPositions`
 * becomes `[]` and `viewAs` is `"member"`.
 *
 * A superadmin's session is injected into `clubs` as `clubRole: "admin"` before
 * this runs, so it downgrades like a stored admin.
 */
export function applyViewAs<C extends ViewAsCtx>(
	ctx: C,
	viewAs: ViewAs | null,
): C & { viewAs: ViewAs | null } {
	const active = effectiveAdminClub(ctx);
	if (viewAs === null || !active) return { ...ctx, viewAs: null };
	return {
		...ctx,
		clubs: ctx.clubs.map((c) =>
			c.clubId === active.clubId ? { ...c, clubRole: "member" as const } : c,
		),
		officerPositions: [],
		viewAs,
	};
}

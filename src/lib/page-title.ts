import { type NavRoute, navLabel } from "#/lib/nav-destinations";

/**
 * The browser-tab title of a page (#1422).
 *
 * Every signed-in page used to read "GavelUp" (the root's title), so an officer
 * with five tabs open could not tell Roster from Dues. A route's `head` now calls
 * one of these, so the title has one shape everywhere: `<page> · <club>`.
 *
 * Pure strings, no React and no router import, so a route module, a server module
 * and a test can all use it. The page label of a registered destination comes
 * from `navLabel` (`nav-destinations.ts`), never retyped.
 */

/** The slice of the `_authed` router context a title reads. */
export interface TitleContext {
	clubs: readonly { clubId: string; name: string }[];
	activeClubId: string | null;
}

/** The product name a page falls back to when it has no club to name. */
export const TITLE_BRAND = "GavelUp";

/**
 * `"<page> · <club name>"` for a signed-in page, or `"<page> · GavelUp"` when
 * there is no active club (a club-less account, or an active id that matches none
 * of the account's clubs).
 */
export function workspaceTitle(page: string, ctx: TitleContext): string {
	const club =
		ctx.activeClubId === null
			? undefined
			: ctx.clubs.find((c) => c.clubId === ctx.activeClubId);
	return `${page} · ${club?.name ?? TITLE_BRAND}`;
}

/** `"<page> · GavelUp"` for a page with no club context (sign-in, claim, consent). */
export function publicTitle(page: string): string {
	return `${page} · ${TITLE_BRAND}`;
}

/**
 * A registered destination's title, its label read from the registry. Routes call
 * this rather than importing `navLabel` themselves: a file that imports the
 * registry is scanned by `nav-destinations.guard.test.ts` for retyped labels, and
 * a page's own heading is allowed to say what its title says.
 */
export function navPageTitle(to: NavRoute, ctx: TitleContext): string {
	return workspaceTitle(navLabel(to), ctx);
}

/** `/club/<slug>/next`'s title: the registered "Next meeting" label and the club. */
export function nextMeetingTitle(clubName: string): string {
	return `${navLabel("/next")} · ${clubName}`;
}

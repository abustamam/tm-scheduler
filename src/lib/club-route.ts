import { notFound, redirect } from "@tanstack/react-router";
import { isClubArchived } from "#/lib/club-archive";
import { getClubByIdentifier } from "#/server/clubs";

type ClubRouteLocation = { pathname: string; searchStr: string };

/**
 * Resolve the `$clubId` URL segment to a club, or bail with the right router
 * signal: `notFound()` when no club matches, or a `redirect` to the canonical
 * slug URL when the segment is a club number / UUID / wrong-case slug. Shared by
 * the `/club` shell and the (shell-escaped) present/print routes.
 *
 * Soft-archived clubs (ADR-0016 / #186) return `notFound()` here, so every
 * public no-auth club loader that funnels through this helper (landing, present,
 * print) treats an archived club as not-found. NEW public club loaders (e.g. the
 * #208 guest-book) MUST route through here — or call `isClubArchived` on their
 * own resolved club — so archived clubs stay inaccessible everywhere but the
 * superadmin console.
 */
export async function resolveClubOrRedirect(
	identifier: string,
	location: ClubRouteLocation,
) {
	const club = await getClubByIdentifier({ data: identifier });
	if (!club || isClubArchived(club)) throw notFound();
	if (identifier !== club.slug) {
		throw redirect({
			href:
				location.pathname.replace(/^\/club\/[^/]+/, `/club/${club.slug}`) +
				location.searchStr,
		});
	}
	return club;
}

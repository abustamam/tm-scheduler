import { notFound, redirect } from "@tanstack/react-router";
import { getClubByIdentifier } from "#/server/clubs";

type ClubRouteLocation = { pathname: string; searchStr: string };

/**
 * Resolve the `$clubId` URL segment to a club, or bail with the right router
 * signal: `notFound()` when no club matches, or a `redirect` to the canonical
 * slug URL when the segment is a club number / UUID / wrong-case slug. Shared by
 * the `/club` shell and the (shell-escaped) print route.
 */
export async function resolveClubOrRedirect(
	identifier: string,
	location: ClubRouteLocation,
) {
	const club = await getClubByIdentifier({ data: identifier });
	if (!club) throw notFound();
	if (identifier !== club.slug) {
		throw redirect({
			href:
				location.pathname.replace(/^\/club\/[^/]+/, `/club/${club.slug}`) +
				location.searchStr,
		});
	}
	return club;
}

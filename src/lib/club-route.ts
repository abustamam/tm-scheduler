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
 * print) treats an archived club as not-found.
 *
 * This helper covers ROUTER loaders only. A session-less `createServerFn` reader
 * structurally cannot route through it — it has no router — and is addressable
 * directly, so it must call `isReadableClub` (or the meeting/member variants) in
 * `#/server/club-readable-logic` on its own. See #544, where nine such readers
 * were open because this guidance was read as covering them.
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

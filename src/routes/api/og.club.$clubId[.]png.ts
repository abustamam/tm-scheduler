import { createFileRoute } from "@tanstack/react-router";
import {
	loadPublicClubCardInput,
	ogPathMatch,
	respondOgCard,
} from "#/server/og-card-logic";

/**
 * GET /api/og/club/$clubId.png (#1411): the 1200x630 link preview of a club's
 * sign-up sheet. Public, no session. 404 for an unknown or archived club
 * (`loadPublicClubCardInput` runs `isReadableClub` first). `?v=` is ignored.
 */
export const Route = createFileRoute("/api/og/club/$clubId.png")({
	server: {
		handlers: {
			// The id comes from the URL, not `params`: the router names the
			// param `clubId.png`, suffix included.
			GET: ({ request }) =>
				respondOgCard(async () => {
					const m = ogPathMatch(request, /\/api\/og\/club\/([^/]+)\.png$/);
					return m ? loadPublicClubCardInput(m[1]) : null;
				}, request),
		},
	},
});

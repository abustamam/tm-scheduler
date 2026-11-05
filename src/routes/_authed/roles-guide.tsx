import { createFileRoute, redirect } from "@tanstack/react-router";
import { navPageTitle } from "#/lib/page-title";
import { getPublicNextMeetingKey } from "#/server/meetings";

/**
 * Shortcut to the active club's public roles guide
 * (`/club/:clubId/roles-guide`), for a signed-in member. The guide is keyed by
 * the club's slug, and the signed-in app only holds the club id, so this asks
 * the same seam `/next` does: `getPublicNextMeetingKey` answers `clubSlug`
 * whether or not a meeting is scheduled, and `null` for an unknown or archived
 * club. With no active club (or an unreadable one) it goes to the dashboard.
 * The officers' role SETUP page is the separate `/admin/roles`.
 */
export const Route = createFileRoute("/_authed/roles-guide")({
	loader: async ({ context }) => {
		const clubId = context.activeClubId;
		if (!clubId) throw redirect({ to: "/dashboard" });
		const r = await getPublicNextMeetingKey({ data: clubId });
		if (!r) throw redirect({ to: "/dashboard" });
		throw redirect({
			to: "/club/$clubId/roles-guide",
			params: { clubId: r.clubSlug },
		});
	},
	head: ({ match }) => ({
		meta: [{ title: navPageTitle("/roles-guide", match.context) }],
	}),
});

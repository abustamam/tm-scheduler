import { createFileRoute, redirect } from "@tanstack/react-router";
import { getPublicNextMeetingKey } from "#/server/meetings";

/**
 * Shortcut to the active club's next meeting, for a signed-in member. It asks
 * the same seam as the per-club permalink `/club/:clubId/next` (#1140), so the
 * two URLs can never name different meetings, and redirects to the meeting's
 * canonical `/club/:clubId/meeting/:key` page in one hop. When nothing is
 * scheduled it hands over to the permalink, which owns the empty state, and
 * with no active club (or an archived one) it goes to the dashboard. There is no
 * standalone "agenda" screen — a meeting IS its agenda (#141).
 */
export const Route = createFileRoute("/_authed/next")({
	loader: async ({ context }) => {
		const clubId = context.activeClubId;
		if (!clubId) throw redirect({ to: "/dashboard" });
		const r = await getPublicNextMeetingKey({ data: clubId });
		if (!r) throw redirect({ to: "/dashboard" });
		if (r.urlKey) {
			throw redirect({
				to: "/club/$clubId/meeting/$meetingId",
				params: { clubId: r.clubSlug, meetingId: r.urlKey },
			});
		}
		throw redirect({
			to: "/club/$clubId/next",
			params: { clubId: r.clubSlug },
		});
	},
});

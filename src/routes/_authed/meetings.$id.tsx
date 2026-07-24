import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getMeeting } from "#/server/meetings";

/**
 * Legacy management URL. The meeting page is now canonical at the pretty URL
 * `/club/:clubId/meeting/:key` (#317 unification). This route resolves the
 * meeting's club slug + date key and redirects there, so every existing
 * `/meetings/:id` link and bookmark keeps working through a single hop. An
 * unknown or non-uuid id → notFound(). Stays under `_authed` (always was); the
 * redirect target re-authorizes per audience on the pretty route.
 */
export const Route = createFileRoute("/_authed/meetings/$id")({
	loader: async ({ params }) => {
		const data = await getMeeting({ data: params.id }).catch(() => null);
		if (!data?.meeting) throw notFound();
		throw redirect({
			to: "/club/$clubId/meeting/$meetingId",
			params: { clubId: data.clubSlug, meetingId: data.urlKey },
		});
	},
});

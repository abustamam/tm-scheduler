import { createFileRoute } from "@tanstack/react-router";
import { loadMeetingCardInput, respondOgCard } from "#/server/og-card-logic";

/**
 * GET /api/og/meeting/$clubId/$meetingKey.png (#1411): the 1200x630 link
 * preview of one meeting. Public, no session. 404 for an unknown or archived
 * club and for a key naming no meeting. `?v=` is ignored (see `respondOgCard`).
 */
export const Route = createFileRoute("/api/og/meeting/$clubId/$meetingKey.png")(
	{
		server: {
			handlers: {
				// Params come from the URL, not `params`: the router names the
				// last one `meetingKey.png`, suffix included.
				GET: ({ request }) =>
					respondOgCard(async () => {
						const m = /\/api\/og\/meeting\/([^/]+)\/([^/]+)\.png$/.exec(
							new URL(request.url).pathname,
						);
						if (!m) return null;
						let key: string;
						try {
							key = decodeURIComponent(m[2]);
						} catch {
							return null;
						}
						return loadMeetingCardInput(m[1], key);
					}, request),
			},
		},
	},
);

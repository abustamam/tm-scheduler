import { createFileRoute } from "@tanstack/react-router";
import { loadClubLogoForServing } from "#/server/club-logo-logic";

/**
 * GET /api/club/$clubId/logo — public binary serving of a club's uploaded
 * logo (#495). No auth: the printed agenda that embeds this `<img>` is
 * already public, and a club logo is not PII.
 *
 * 404s for: an unknown club, an ARCHIVED club (ADR-0016 — public no-auth
 * loaders return not-found for archived clubs; archiving also doubles as
 * this feature's takedown lever, per the trademark constraints in #495), and
 * a club with no logo uploaded. `loadClubLogoForServing` collapses all three
 * into `null`.
 *
 * `Cache-Control: immutable` is safe ONLY because every caller builds this
 * URL through `clubLogoUrl` (`#/lib/club-logo-url.ts`), which always appends
 * a `?v=<updatedAt epoch ms>` — a replaced logo gets a new URL rather than
 * silently serving the old bytes from cache.
 */
export const Route = createFileRoute("/api/club/$clubId/logo")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const logo = await loadClubLogoForServing(params.clubId);
				if (!logo) {
					return new Response("Not found.", { status: 404 });
				}
				return new Response(new Uint8Array(logo.bytes), {
					status: 200,
					headers: {
						"content-type": logo.mime,
						"cache-control": "public, max-age=31536000, immutable",
					},
				});
			},
		},
	},
});

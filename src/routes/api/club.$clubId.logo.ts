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
			GET: async ({ params, request }) => {
				const logo = await loadClubLogoForServing(params.clubId);
				if (!logo) {
					return new Response("Not found.", { status: 404 });
				}

				// `immutable` is only sound for a URL that actually names a
				// version. A bare `/api/club/:id/logo`, or a stale `?v=`, would
				// otherwise be pinned in browser and proxy caches for a year —
				// a replaced logo would never reach anyone holding that URL, and
				// an archive-takedown could not reach already-cached copies
				// either. Mismatches still SERVE (a stale link keeps rendering,
				// which the offline print flow depends on) but revalidate soon.
				const requestedVersion = new URL(request.url).searchParams.get("v");
				const isCurrentVersion =
					requestedVersion === String(logo.updatedAt.getTime());

				return new Response(new Uint8Array(logo.bytes), {
					status: 200,
					headers: {
						"content-type": logo.mime,
						"cache-control": isCurrentVersion
							? "public, max-age=31536000, immutable"
							: "public, max-age=300, must-revalidate",
						// Defense in depth. `mime` can only ever be one of the two
						// values the upload allow-list permits, and an <img> load
						// never executes its response as script — but this URL can
						// also be navigated to directly, and sniffing a polyglot
						// whose bytes start with a valid PNG/JPEG signature is the
						// edge this closes.
						"x-content-type-options": "nosniff",
					},
				});
			},
		},
	},
});

import { createFileRoute } from "@tanstack/react-router";
import {
	loadClubLogoForServing,
	loadClubLogoMeta,
} from "#/server/club-logo-logic";

/**
 * The response's validator, derived from the same `updatedAt` the `?v=` param
 * carries — so a conditional request and a cache-busting URL agree on what
 * "this version" means by construction rather than by coincidence.
 *
 * Strong, not weak: for a given version the bytes are byte-identical, because a
 * replacement writes a new `updated_at`.
 */
function etagFor(updatedAt: Date): string {
	return `"${updatedAt.getTime()}"`;
}

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
 * ## Caching, and why the year-long `immutable` had to go (#517)
 *
 * Every caller builds this URL through `clubLogoUrl` (`#/lib/club-logo-url.ts`),
 * which appends `?v=<updatedAt epoch ms>` — so REPLACEMENT was never the problem:
 * a new logo gets a new URL. `immutable` bought bytes, not correctness.
 *
 * What it cost was the takedown. ADR-0024 constraint 4 makes archiving the lever
 * for an infringing logo, and `immutable` tells every cache not to revalidate, so
 * a copy fetched the day before an archive kept rendering for up to a year while
 * the origin 404'd. Worse than the issue reported: the service worker's own
 * eviction (#556) revalidates with a plain `fetch`, which is served BY the HTTP
 * cache — so `immutable` did not merely delay the eviction, it prevented it from
 * ever running. The one mechanism built to reach already-cached copies was
 * disabled by this header.
 *
 * So: a bounded `max-age` plus an `ETag`, and `must-revalidate` rather than
 * `immutable`. Revalidation is what makes the takedown reachable, and the ETag is
 * what makes it cheap — a conditional request answers 304 with no body and
 * without pulling 256 KB of `bytea`, because it resolves through
 * `loadClubLogoMeta`, which cannot select `bytes`. On an archived club that same
 * request 404s, which is precisely where the lever now bites.
 *
 * The mismatched-version branch keeps its short `max-age`: a stale or bare URL
 * must not pin anything, and it already reasoned this way.
 */
/** Bounded so a takedown reaches HTTP caches in minutes rather than months.
 *  Not a latency budget — the service worker answers from its own cache
 *  instantly either way, so this only paces the background revalidation. */
const LOGO_MAX_AGE_SECONDS = 300;
export const Route = createFileRoute("/api/club/$clubId/logo")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				// Conditional request FIRST, and gated: `loadClubLogoMeta` runs the
				// same `isReadableClub` check as the byte loader below but cannot
				// select `bytes`, so a revalidation costs one small row — and an
				// archived club 404s here rather than being told "still fresh".
				// That 404 is what the service worker's eviction is waiting for.
				const ifNoneMatch = request.headers.get("if-none-match");
				if (ifNoneMatch) {
					const meta = await loadClubLogoMeta(params.clubId);
					if (!meta) {
						return new Response("Not found.", { status: 404 });
					}
					const etag = etagFor(meta.updatedAt);
					// Exact compare, not `includes`: a client may send a list, and
					// `W/"123"` or a prefix must not satisfy a strong validator.
					if (ifNoneMatch === etag) {
						return new Response(null, {
							status: 304,
							headers: {
								etag,
								"cache-control": `public, max-age=${LOGO_MAX_AGE_SECONDS}, must-revalidate`,
							},
						});
					}
				}

				const logo = await loadClubLogoForServing(params.clubId);
				if (!logo) {
					return new Response("Not found.", { status: 404 });
				}

				// ONE `Cache-Control` for both, now that neither is a year.
				//
				// This used to branch on whether `?v=` named the current version,
				// because only a current URL could safely earn `immutable`. With that
				// gone the asymmetry buys nothing: a client does not discover a
				// replaced logo by revalidating the OLD url, it discovers it by
				// re-rendering the page, which emits the new `?v=`. A second, shorter
				// max-age for stale URLs would be a number to explain and nothing
				// more. A stale link still SERVES, which the offline print flow
				// depends on.
				return new Response(new Uint8Array(logo.bytes), {
					status: 200,
					headers: {
						"content-type": logo.mime,
						etag: etagFor(logo.updatedAt),
						"cache-control": `public, max-age=${LOGO_MAX_AGE_SECONDS}, must-revalidate`,
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

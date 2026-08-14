// GavelUp offline service worker (issue #174, extended by #176 slice 1).
//
// Scope: read-only offline access to a meeting's Present and Print views AND
// the canonical pretty meeting page (`/club/:slug/meeting/:key`, which for a
// signed-in member holds the minutes; the legacy `/meetings/:id` is now just a
// redirect to it). A full-page load of `/…/present`, `/…/print`, or the pretty
// meeting page while ONLINE primes the cache; the loader data is inlined in the
// SSR HTML (TanStack Start dehydration) and the page re-renders purely
// client-side, so a cached HTML document + cached JS/CSS assets is enough to
// render offline with no network.
//
// Strategy:
//   - Present/Print + the pretty meeting page → network-first (fresh when
//     online, cached when offline). The navigation-layer widening is kept
//     strictly to meeting paths — no other authed page lands in the cache.
//   - Static assets (script/style/font/image) → stale-while-revalidate.
//   - Writes (POST) and cross-origin requests are never intercepted.
//
// Caching a signed-in page writes authed content to the on-device cache; this
// is bounded by #176's single-user-device assumption, which is why the widening
// stays scoped to the meeting paths (not every `/_authed` navigation).
//
// Takedown (#556): a cached copy outlives the server's refusal to serve it, so a
// 404/410 EVICTS rather than being a no-op — see `isGoneResponse` and `evict`.
//
// The two caches carry SEPARATE versions on purpose. Bumping a version drops that
// cache wholesale on the next activation, which is the only way to clear copies
// already sitting on devices — but the two have very different blast radii. The
// nav cache holds pre-takedown agendas and nothing in it identifies which club
// they belong to, so #556 bumps it to v4 and accepts that every club re-primes
// its offline pages once. The asset cache holds hashed build output a takedown has
// no bearing on, plus everything under `public/` (Nitro serves that with
// `maxAge: 0`, so a 396K hero image really re-downloads) — dropping it would cost
// every device a re-fetch to remove nothing. It stays at v3, and `activate`
// instead purges the one takedown-sensitive thing in it: club crests.
//
// A third on-device copy is NOT this file's: `gavelup.auth-context` in localStorage
// holds the club switcher's names and club numbers. Its key is bumped in the same
// release, v1 → v2, for the same one-time-clear reason the nav cache is — see
// `src/lib/offline-auth-context.ts`, which is authoritative for the current value.

const NAV_VERSION = "v4";
const ASSET_VERSION = "v3";
const NAV_CACHE = `gavelup-nav-${NAV_VERSION}`;
const ASSET_CACHE = `gavelup-assets-${ASSET_VERSION}`;
const OWNED_CACHES = new Set([NAV_CACHE, ASSET_CACHE]);

/** The club-crest endpoint. Its `?v=` is a revision of one resource, not an id. */
const LOGO_PATH = /^\/api\/club\/[^/]+\/logo$/;

self.addEventListener("install", () => {
	// Take over as soon as the new worker is parsed; there is no precache step.
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			// Drop caches from older versions.
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter((k) => k.startsWith("gavelup-") && !OWNED_CACHES.has(k))
					.map((k) => caches.delete(k)),
			);
			// ASSET_CACHE is deliberately not version-bumped (see the header), so
			// sweep the only thing in it a takedown must remove. Every club's crest
			// goes, not just an archived club's — the worker cannot tell which is
			// which, and the cost is one small same-origin image per club.
			const assets = await caches.open(ASSET_CACHE);
			for (const request of await assets.keys()) {
				if (LOGO_PATH.test(new URL(request.url).pathname)) {
					await assets.delete(request);
				}
			}
			await self.clients.claim();
		})(),
	);
});

/**
 * The only navigations we cache offline: a meeting Present/Print view, the
 * canonical pretty meeting page (`/club/<slug>/meeting/<key>`, which for a
 * signed-in member holds the minutes), or the legacy `/meetings/<id>` redirect
 * page. Kept scoped to meeting paths so no other navigation is written to the
 * offline cache.
 */
function isOfflineRoute(url) {
	return (
		url.pathname.endsWith("/present") ||
		url.pathname.endsWith("/print") ||
		/^\/club\/[^/]+\/meeting\//.test(url.pathname) ||
		url.pathname.startsWith("/meetings/")
	);
}

/** Hashed build output + linked assets that are safe to serve from cache. */
function isCacheableAsset(url, request) {
	if (["script", "style", "font", "image", "worker"].includes(request.destination)) {
		return true;
	}
	return url.pathname.startsWith("/_build/") || url.pathname.startsWith("/assets/");
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (request.mode === "navigate") {
		if (isOfflineRoute(url)) {
			event.respondWith(networkFirst(request, url, NAV_CACHE));
		}
		return; // Every other navigation uses the default network path.
	}

	if (isCacheableAsset(url, request)) {
		event.respondWith(staleWhileRevalidate(event, request, url, ASSET_CACHE));
	}
});

/**
 * Whether a response means "this is gone, drop what you cached" (#556).
 *
 * Archiving a club is the takedown lever (ADR-0016 / ADR-0024) and #544 made an
 * archived club's public pages answer not-found — measured against a dev server:
 * the meeting page and `/…/present` return 404, `/…/print` 307s to `?layout=grid`
 * and that 404s, and `/api/club/:id/logo` 404s. Because `response.ok` was false,
 * the pre-archive entry was neither overwritten NOR evicted, so every offline
 * reload kept serving a complete agenda — assignee names, speech titles, Word of
 * the Day — from a club that had been taken down.
 *
 * NOTE this rests on an assumption no test in this repo can hold: that a
 * `notFound()` in a route loader keeps mapping to an HTTP 404. The sw tests inject
 * the status themselves, so they stay green either way; if a framework upgrade made
 * that a 200, `response.ok` would become true, the not-found page would be CACHED
 * over the agenda, and this eviction would never run. That is a live risk, filed
 * rather than fixed.
 *
 * Three narrowings, each guarding the same failure — destroying a club's offline
 * agenda at the moment it is needed:
 *
 *   - Only 404/410, never every non-ok status. A 500 or an expired session must
 *     not evict; serving a stale copy through a server blip is the entire reason
 *     this cache exists, and one bad deploy would otherwise cost every club its
 *     offline access.
 *   - Not a redirected response. A captive portal on venue wifi bounces the
 *     request to a login page, and its answer must never read as a takedown. This
 *     catches the redirecting portal, which is the common shape; a fully
 *     transparent proxy forging a same-origin 404 is not detectable here.
 *   - Same-origin and non-opaque only, so a response whose body we could not read
 *     cannot trigger a delete.
 */
function isGoneResponse(response) {
	if (!response || response.redirected || response.type === "opaque") {
		return false;
	}
	if (response.status !== 404 && response.status !== 410) return false;
	try {
		// An empty `url` (some synthetic responses) is not something to trust.
		return new URL(response.url).origin === self.location.origin;
	} catch {
		return false;
	}
}

/**
 * The meeting a cached nav URL belongs to, without its per-surface suffix.
 *
 * Derived from the URL SHAPE — everything up to and including the meeting key —
 * rather than by stripping a list of known surfaces. The list version stripped
 * `/present|/print` and therefore missed `/word` and `/vote`, which
 * `isOfflineRoute`'s `/^\/club\/[^/]+\/meeting\//` also caches: a takedown evicted
 * the agenda and left the Word of the Day poster and the live ballot answering
 * offline reloads. Any surface added under a meeting later is covered by
 * construction, which a list can never be.
 *
 * A legacy `/meetings/<uuid>` URL matches nothing here and returns itself, which is
 * right — it is its own key, not a surface of a club-scoped meeting path.
 */
function meetingPrefix(pathname) {
	const meeting = pathname.match(/^(\/club\/[^/]+\/meeting\/[^/]+)/);
	return meeting ? meeting[1] : pathname;
}

/**
 * Drop what we cached for a URL that is now gone.
 *
 * NAV: evict the whole MEETING, not the one URL. One meeting occupies up to three
 * cache keys (`…/meeting/<key>`, `…/present`, `…/print?layout=…`), so a device that
 * primed all three would otherwise keep answering offline reloads from the two it
 * did not happen to re-request — a takedown that looks done and is not. The nav
 * cache is bounded to meeting paths, so enumerating it is cheap.
 *
 * ASSETS: an exact delete, except for the club crest, where `ignoreSearch` clears
 * every `?v=` revision — which is the point on a takedown, since a logo replaced
 * before archiving leaves more than one. Applying `ignoreSearch` to the whole asset
 * cache would be both wrong and expensive: it is unbounded hashed build output, the
 * option makes the browser enumerate the cache instead of hashing one key, and a
 * stale chunk 404s routinely after every deploy.
 */
async function evict(cache, request, url, isNav) {
	if (isNav) {
		const prefix = meetingPrefix(url.pathname);
		for (const cached of await cache.keys()) {
			if (meetingPrefix(new URL(cached.url).pathname) === prefix) {
				await cache.delete(cached);
			}
		}
		return;
	}
	if (LOGO_PATH.test(url.pathname)) {
		await cache.delete(request, { ignoreSearch: true });
		return;
	}
	await cache.delete(request);
}

// Fresh copy when the network is up (and re-cache it); the last cached copy
// when it is not. For Print, the `?layout=` search param varies but the SSR
// data is identical, so an offline reload falls back to any cached Print page —
// which is also why eviction clears the whole meeting rather than one URL.
async function networkFirst(request, url, cacheName) {
	const cache = await caches.open(cacheName);
	try {
		const response = await fetch(request);
		if (response && response.ok) cache.put(request, response.clone());
		else if (isGoneResponse(response)) await evict(cache, request, url, true);
		return response;
	} catch (err) {
		const exact = await cache.match(request);
		if (exact) return exact;
		const ignoringSearch = await cache.match(request, { ignoreSearch: true });
		if (ignoringSearch) return ignoringSearch;
		throw err;
	}
}

// Serve cache immediately, refresh it in the background for next time.
//
// A club's own uploaded logo (`/api/club/:id/logo`) lands here — `destination` is
// `"image"` — so the takedown eviction applies to it too. Note `cache.match` is
// EXACT here (no `ignoreSearch` fallback, unlike `networkFirst`), which is why
// `clubLogoUrl` must keep emitting `?v=`; see that module's header.
//
// The revalidation is registered with `event.waitUntil` because the response
// resolves from cache first: without it the browser may terminate the worker as
// soon as `respondWith` settles, and the eviction would simply never run.
async function staleWhileRevalidate(event, request, url, cacheName) {
	const cache = await caches.open(cacheName);
	const cached = await cache.match(request);
	const network = fetch(request)
		.then(async (response) => {
			if (response && response.ok) cache.put(request, response.clone());
			else if (isGoneResponse(response)) {
				await evict(cache, request, url, false);
			}
			return response;
		})
		.catch(() => cached);
	event.waitUntil(network);
	return cached || network;
}

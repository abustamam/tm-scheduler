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
			// Re-prime whatever the user is looking at, now that we control it.
			await primeOpenMeetingPages();
		})(),
	);
});

/**
 * Cache the offline routes that are OPEN RIGHT NOW, on activation (#362).
 *
 * Without this, one online load is not enough to prime a page, and that is the
 * bug reported from a live meeting: agenda loaded online, wifi cut, reload
 * failed. Two independent ways to land there, and this closes both.
 *
 *  - A WORKER UPDATE. The load was served by the previous worker, which cached
 *    the document under the previous `NAV_CACHE` name. The new worker then
 *    activates and the sweep above deletes every cache not in `OWNED_CACHES` —
 *    including that one. `gavelup-nav-v4` is empty, the reload finds nothing,
 *    `networkFirst` rethrows and the browser shows its own error page. #556's
 *    v3 → v4 bump and every later edit to this file each produce exactly that
 *    window.
 *  - A FIRST VISIT. `registerServiceWorker` runs on `load`, so the document
 *    that triggers registration was fetched before any worker existed and was
 *    never intercepted. Nothing is cached until a SECOND online load.
 *
 * Both mean "prime it before the meeting" silently does nothing, which is worse
 * than having no offline mode: the club believes it is covered.
 *
 * This is the NARROWER of the two priming paths, and reading it as the general
 * one is how v1.25.8.0 shipped a fix that did not fix the report. `activate`
 * fires only on the load where the worker changes; on every load after that the
 * worker is already current, this never runs, and before v1.25.9.0 nothing else
 * primed anything. The user re-ran the repro against a deploy that contained
 * this function and Present still failed offline, because their worker was
 * already up to date — the ordinary case, not an edge one. `primeSiblings` in
 * `networkFirst` is what covers a normal visit; this covers only the two
 * windows above, where the open page was never intercepted at all.
 *
 * Best-effort by construction. A failed fetch here means we activated while
 * already offline, where there is nothing to prime from and the old cache is
 * gone regardless — so it must not reject and take the activation with it.
 */
async function primeOpenMeetingPages() {
	let clients = [];
	try {
		clients = await self.clients.matchAll({ type: "window" });
	} catch {
		return;
	}
	const cache = await caches.open(NAV_CACHE);
	const targets = new Set();
	for (const client of clients) {
		let url;
		try {
			url = new URL(client.url);
		} catch {
			continue;
		}
		if (url.origin !== self.location.origin) continue;
		if (!isOfflineRoute(url)) continue;
		for (const surface of meetingSurfaces(url)) targets.add(surface);
	}
	await Promise.all([...targets].map((href) => primeOne(cache, href)));
}

/**
 * The cache keys ONE open meeting occupies: the page itself, Present, and Print.
 *
 * `evict` has always treated a meeting as three keys — its own comment says so,
 * and clears the whole prefix on a takedown precisely so a device that primed
 * all three cannot keep answering from the two it did not happen to re-request.
 * Priming treated it as ONE, and that asymmetry is the second half of #362: the
 * meeting page came back offline (v1.22.7.0) and then Present did not, because
 * Present is its own entry and had never been fetched.
 *
 * That is also how a club actually uses this. Someone opens the agenda before
 * the meeting, and the surface they reach for during it is Present — a
 * `target="_blank"` link, so a real navigation the worker sees, into a URL
 * nothing had primed.
 *
 * A non-meeting offline route (`/meetings/<id>`) has no siblings; it primes
 * itself.
 */
/** Build output a primed document may pull in. Mirrors `isCacheableAsset`. */
const ASSET_PATH = /^\/(?:_build|assets)\//;

/** Ceiling on assets primed per document (#362). See `primeAssetsOf`. */
const MAX_PRIMED_ASSETS = 60;

function meetingSurfaces(url) {
	const prefix = meetingPrefix(url.pathname);
	if (prefix === url.pathname && !/^\/club\/[^/]+\/meeting\//.test(prefix)) {
		return [url.href];
	}
	const base = `${url.origin}${prefix}`;
	return [base, `${base}/present`, `${base}/print`];
}

/**
 * Fetch the OTHER surfaces of the meeting just visited, skipping the one that
 * was actually requested (#362).
 *
 * Always, not only-if-missing. A meeting's roles and speech titles change right
 * up to the moment it starts, so a Present page cached last week is worse than
 * useless on the night — it shows a line-up that has moved. The cost is two
 * small SSR documents per meeting-page view, on an app where viewing a meeting
 * page is a deliberate act rather than incidental traffic.
 *
 * Never throws: this runs inside `waitUntil`, and a rejection there is reported
 * as a failed install/fetch for no user benefit.
 */
async function primeSiblings(cache, url, requestedUrl) {
	// Compared without the query string, because the surface list is built from
	// bare paths while the request that triggered it may carry one: a reload of
	// `/…/print?layout=grid` would otherwise not match `/…/print` and re-fetch
	// the page the browser is in the middle of being served.
	const requested = `${requestedUrl.origin}${requestedUrl.pathname}`;
	for (const href of meetingSurfaces(url)) {
		if (href === requested) continue;
		await primeOne(cache, href);
	}
}

/** Fetch one URL and store it, or leave the cache untouched. Never throws. */
async function primeOne(cache, href) {
	try {
		const response = await fetch(href);
		if (!response || !response.ok || response.type === "opaque") return;
		// Follow the redirect rather than refusing it, then judge the DESTINATION.
		//
		// `!response.redirected` was too blunt: `/…/print` legitimately 307s to
		// `?layout=grid`, so refusing every redirect meant Print could never be
		// primed. What actually distinguishes a captive portal is WHERE it lands —
		// its login page is another origin, or a path that is not an offline route
		// at all. Both fail this check; the Print redirect passes.
		let finalUrl;
		try {
			finalUrl = new URL(response.url || href);
		} catch {
			return;
		}
		if (finalUrl.origin !== self.location.origin) return;
		if (!isOfflineRoute(finalUrl)) return;
		// Keyed by the FINAL url, so Print is stored as `?layout=grid` — which is
		// what `networkFirst`'s `ignoreSearch` fallback then answers a bare
		// `/…/print` request from.
		//
		// A URL STRING as the key, not `new Request(...)`: the Cache API accepts
		// either, and this file constructs no Request anywhere else, so the test
		// harness has none to inject.
		await cache.put(finalUrl.href, response.clone());
		await primeAssetsOf(response.clone(), finalUrl);
	} catch {
		// Activated while offline. Nothing to prime from.
	}
}

/**
 * Cache the build assets a primed document references (#362, second gap).
 *
 * Priming a DOCUMENT is not the same as priming a PAGE. `fetch(href)` retrieves
 * the HTML and nothing else — the browser is what normally requests a page's
 * scripts, and `staleWhileRevalidate` only ever caches an asset somebody has
 * already asked for. So a Present page primed as a document alone would come
 * back offline as un-hydrated SSR output: the first slide rendered, and no way
 * to advance it. On the night, that is its own bug report.
 *
 * Parsed with a regex rather than a real parser because a service worker has no
 * DOM. That is acceptable HERE and would not be in general: the only thing read
 * out is `/_build/` and `/assets/` paths, which are hashed build output, so a
 * mis-parse's worst case is a URL that 404s and is skipped — never wrong
 * content. Same match set `isCacheableAsset` uses, from the same constant.
 */
async function primeAssetsOf(response, documentUrl) {
	let html;
	try {
		html = await response.text();
	} catch {
		return;
	}
	const cache = await caches.open(ASSET_CACHE);
	const seen = new Set();
	for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
		// Bounded so a large or generated document cannot turn one navigation
		// into unbounded work: this runs inside `waitUntil`, which has a wall
		// clock the browser enforces by killing the worker.
		if (seen.size >= MAX_PRIMED_ASSETS) break;
		let assetUrl;
		try {
			assetUrl = new URL(match[1], documentUrl.href);
		} catch {
			continue;
		}
		if (assetUrl.origin !== self.location.origin) continue;
		if (!ASSET_PATH.test(assetUrl.pathname)) continue;
		if (seen.has(assetUrl.href)) continue;
		seen.add(assetUrl.href);
		// Already held: skip. These paths are content-hashed, so a cached copy can
		// never be the stale one — which is what keeps the repeat cost of priming
		// on EVERY visit down to the documents alone.
		if (await cache.match(assetUrl.href)) continue;
		try {
			const asset = await fetch(assetUrl.href);
			if (asset?.ok && asset.type !== "opaque") {
				await cache.put(assetUrl.href, asset.clone());
			}
		} catch {
			// Went offline mid-prime. Keep whatever landed.
		}
	}
}

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
	return ASSET_PATH.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (request.mode === "navigate") {
		if (isOfflineRoute(url)) {
			event.respondWith(networkFirst(event, request, url, NAV_CACHE));
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
async function networkFirst(event, request, url, cacheName) {
	const cache = await caches.open(cacheName);
	try {
		const response = await fetch(request);
		if (response && response.ok) {
			cache.put(request, response.clone());
			// Prime this meeting's OTHER surfaces on the same visit (#362).
			//
			// Activation priming alone was not enough, and the gap is the whole
			// reason Present still failed after v1.25.8.0: `activate` fires only on
			// the ONE load where the worker updates. Every load after that — the
			// normal case — has a current worker, so nothing ran and Present was
			// never fetched. The user's mental model is "I opened the meeting
			// online, so the meeting works offline", and the meeting is three pages.
			//
			// `event.waitUntil`, not fire-and-forget: `respondWith` settles as soon
			// as the document is served, and the browser may kill the worker at that
			// point — which is the same reason `staleWhileRevalidate` takes `event`.
			event.waitUntil(primeSiblings(cache, url, url));
		} else if (isGoneResponse(response)) {
			await evict(cache, request, url, true);
		}
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
	// The crest revalidates past the HTTP cache; every other asset does not.
	//
	// This is what made the eviction below reachable at all (#517). A plain
	// `fetch` consults the browser's HTTP cache, and the logo route used to answer
	// `max-age=31536000, immutable` — so the revalidation was served from that
	// cache, `response.ok` stayed true, and `isGoneResponse` could never fire. The
	// one mechanism built to reach already-cached copies on a takedown (#556) was
	// disabled by a caching header, silently, in the direction that looks fine.
	//
	// `no-cache` revalidates WITH the server rather than skipping the cache
	// (`reload`), so the route's ETag answers 304 with no body in the normal case
	// and 404 on an archived club, which is the status the eviction needs. Scoped
	// to the logo because the rest of this cache is hashed build output whose URL
	// changes on every deploy: it can never go stale, so a conditional request per
	// asset would be pure cost.
	// `fetch(request, init)` rather than `new Request(request, init)`: the two are
	// equivalent per spec, and this one needs no `Request` constructor — which the
	// test harness does not inject, since sw.js otherwise never builds one.
	const network = fetch(
		request,
		LOGO_PATH.test(url.pathname) ? { cache: "no-cache" } : undefined,
	)
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

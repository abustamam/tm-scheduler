// GavelUp offline service worker (issue #174).
//
// Scope: read-only offline access to a meeting's Present and Print views. A
// full-page load of `/…/present` or `/…/print` while ONLINE primes the cache;
// the loader data is inlined in the SSR HTML (TanStack Start dehydration) and
// `buildSlideDeck` renders purely client-side, so a cached HTML document +
// cached JS/CSS assets is enough to re-render the deck with no network.
//
// Strategy:
//   - Present/Print navigations → network-first (fresh when online, cached when
//     offline). Nothing else is cached at the navigation layer, so authed pages
//     never land in the offline cache.
//   - Static assets (script/style/font/image) → stale-while-revalidate.
//   - Writes (POST) and cross-origin requests are never intercepted.
//
// Bumping VERSION invalidates every cache on the next activation.

const VERSION = "v1";
const NAV_CACHE = `gavelup-nav-${VERSION}`;
const ASSET_CACHE = `gavelup-assets-${VERSION}`;
const OWNED_CACHES = new Set([NAV_CACHE, ASSET_CACHE]);

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
			await self.clients.claim();
		})(),
	);
});

/** A meeting Present or Print view — the only navigations we cache offline. */
function isOfflineRoute(url) {
	return (
		url.pathname.endsWith("/present") || url.pathname.endsWith("/print")
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
			event.respondWith(networkFirst(request, NAV_CACHE));
		}
		return; // Every other navigation uses the default network path.
	}

	if (isCacheableAsset(url, request)) {
		event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
	}
});

// Fresh copy when the network is up (and re-cache it); the last cached copy
// when it is not. For Print, the `?layout=` search param varies but the SSR
// data is identical, so an offline reload falls back to any cached Print page.
async function networkFirst(request, cacheName) {
	const cache = await caches.open(cacheName);
	try {
		const response = await fetch(request);
		if (response && response.ok) cache.put(request, response.clone());
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
async function staleWhileRevalidate(request, cacheName) {
	const cache = await caches.open(cacheName);
	const cached = await cache.match(request);
	const network = fetch(request)
		.then((response) => {
			if (response && response.ok) cache.put(request, response.clone());
			return response;
		})
		.catch(() => cached);
	return cached || network;
}

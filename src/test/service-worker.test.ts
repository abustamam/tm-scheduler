/**
 * Behavioral tests for `public/sw.js` — the takedown eviction added for #556.
 *
 * The service worker is a plain script, not a module: its helpers are unexported
 * and it addresses `self`, `caches` and `fetch` as globals. So this evaluates the
 * real file with those three injected and drives the REAL event handlers, rather
 * than asserting the source contains a string.
 *
 * ## What this harness can and cannot prove
 *
 * `FakeCache` is a hand-written model of the Cache API, so an eviction assertion is
 * really an assertion about the FAKE unless the model is right where it matters.
 * Two known divergences, both recorded rather than papered over:
 *
 *  - `Vary` is not modelled. The real query algorithm only matches a stored entry
 *    if the request satisfies the cached response's `Vary` header, so a real
 *    `cache.delete` can miss an entry this fake always finds. Divergence is in the
 *    same direction as the code (looks evicted here, may not be on a device).
 *  - Worker termination is not modelled. The fake keeps the process alive, so a
 *    revalidation that is never registered with `waitUntil` still completes here.
 *    That is why `waitUntil` is modelled explicitly and awaited below — it is the
 *    only reason the asset-path eviction is observable at all.
 *
 * And the biggest limit, which no fixture here can close: every eviction test
 * INJECTS the 404. That an archived club's page actually answers 404 is an
 * assumption about the framework, not something these tests verify — see
 * `isGoneResponse`'s note in `sw.js`.
 *
 * No new dependency and no browser: everything here is in-memory.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SW_SOURCE = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");

const ORIGIN = "https://gavelup.app";
const MEETING = "/club/acme/meeting/2026-01-05-1900";
const LOGO = "/api/club/11111111-1111-1111-1111-111111111111/logo";
/** `clubLogoUrl` always appends `?v=<epochMs>` — see `src/lib/club-logo-url.ts`. */
const LOGO_V1 = `${LOGO}?v=1700000000000`;
const LOGO_V2 = `${LOGO}?v=1800000000000`;
const AS_IMAGE = { mode: "no-cors", destination: "image" };

interface FakeRequest {
	url: string;
	method: string;
	mode: string;
	destination: string;
}

interface FakeResponse {
	ok: boolean;
	status: number;
	body: string;
	url: string;
	redirected: boolean;
	type: string;
	clone(): FakeResponse;
}

function request(path: string, overrides?: Partial<FakeRequest>): FakeRequest {
	return {
		url: `${ORIGIN}${path}`,
		method: "GET",
		mode: "navigate",
		destination: "",
		...overrides,
	};
}

function response(
	status: number,
	body: string,
	overrides?: Partial<FakeResponse>,
): FakeResponse {
	const res: FakeResponse = {
		ok: status >= 200 && status < 300,
		status,
		body,
		// Stamped by the harness from the request when not overridden.
		url: "",
		redirected: false,
		type: "basic",
		clone: () => res,
		...overrides,
	};
	return res;
}

const withoutSearch = (url: string): string => url.split("?")[0] ?? url;

/** Minimal Cache modelling the query options sw.js relies on. */
class FakeCache {
	entries = new Map<string, string>();

	keys(): Promise<FakeRequest[]> {
		return Promise.resolve(
			[...this.entries.keys()].map((url) => ({
				url,
				method: "GET",
				mode: "navigate",
				destination: "",
			})),
		);
	}

	async match(
		req: FakeRequest,
		options?: { ignoreSearch?: boolean },
	): Promise<FakeResponse | undefined> {
		const exact = this.entries.get(req.url);
		if (exact !== undefined) return response(200, exact, { url: req.url });
		if (!options?.ignoreSearch) return undefined;
		const base = withoutSearch(req.url);
		for (const [url, body] of this.entries) {
			if (withoutSearch(url) === base) return response(200, body, { url });
		}
		return undefined;
	}

	async put(req: FakeRequest, res: FakeResponse): Promise<void> {
		this.entries.set(req.url, res.body);
	}

	async delete(
		req: FakeRequest,
		options?: { ignoreSearch?: boolean },
	): Promise<boolean> {
		if (!options?.ignoreSearch) return this.entries.delete(req.url);
		const base = withoutSearch(req.url);
		let deleted = false;
		for (const url of [...this.entries.keys()]) {
			if (withoutSearch(url) === base) {
				this.entries.delete(url);
				deleted = true;
			}
		}
		return deleted;
	}
}

interface Harness {
	/** Cache names the worker opened, in order. */
	opened: string[];
	caches: Map<string, FakeCache>;
	/** Queue a response (or an Error to simulate being offline) per fetch. */
	nextFetch: (FakeResponse | Error)[];
	/** Fetches the worker made beyond what the test queued. */
	surplusFetches: number;
	dispatchFetch(req: FakeRequest): Promise<FakeResponse | undefined>;
	activate(): Promise<void>;
	cacheFor(name: string): FakeCache;
	seed(name: string, entries: Record<string, string>): FakeCache;
}

function loadServiceWorker(): Harness {
	const listeners = new Map<string, ((event: unknown) => void)[]>();
	const cacheStore = new Map<string, FakeCache>();
	const opened: string[] = [];
	const nextFetch: (FakeResponse | Error)[] = [];
	const state = { surplus: 0 };

	const cachesApi = {
		async open(name: string): Promise<FakeCache> {
			opened.push(name);
			let cache = cacheStore.get(name);
			if (!cache) {
				cache = new FakeCache();
				cacheStore.set(name, cache);
			}
			return cache;
		},
		async keys(): Promise<string[]> {
			return [...cacheStore.keys()];
		},
		async delete(name: string): Promise<boolean> {
			return cacheStore.delete(name);
		},
	};

	const selfApi = {
		addEventListener: (type: string, handler: (event: unknown) => void) => {
			// An array, not a single slot: a real worker dispatches to EVERY
			// registered listener, and a harness that kept only the last would
			// silently test less code than it appears to.
			listeners.set(type, [...(listeners.get(type) ?? []), handler]);
		},
		skipWaiting: () => {},
		clients: { claim: async () => {} },
		location: { origin: ORIGIN },
	};

	const fetchApi = async (req: FakeRequest): Promise<FakeResponse> => {
		// Resolve on a MACROTASK, not a microtask. This is what models worker
		// termination: a revalidation the worker did not register with
		// `event.waitUntil` cannot finish inside the response's microtask drain, so
		// an assertion made after the response sees the un-evicted cache — which is
		// exactly what a browser would do. With a microtask the whole chain drained
		// before any assertion ran, and removing `event.waitUntil(network)` from
		// sw.js left every test green.
		await new Promise((r) => setTimeout(r, 0));
		const queued = nextFetch.shift();
		if (queued === undefined) {
			// Do NOT throw: `networkFirst` catches any throw as "offline", so an
			// unexpected fetch would masquerade as the offline path and the cached-copy
			// assertions would pass for the wrong reason.
			state.surplus += 1;
			return response(503, "unexpected fetch", { url: req.url });
		}
		if (queued instanceof Error) throw queued;
		return queued.url
			? queued
			: { ...queued, url: req.url, clone: () => queued };
	};

	// `new Function` rather than an import: sw.js is a classic worker script with
	// no exports, and its three globals arrive as parameters that shadow them.
	new Function("self", "caches", "fetch", SW_SOURCE)(
		selfApi,
		cachesApi,
		fetchApi,
	);

	function handlersFor(type: string): ((event: unknown) => void)[] {
		const found = listeners.get(type) ?? [];
		if (found.length === 0)
			throw new Error(`sw.js registered no ${type} listener`);
		return found;
	}

	return {
		opened,
		caches: cacheStore,
		nextFetch,
		get surplusFetches() {
			return state.surplus;
		},
		cacheFor(name) {
			const cache = cacheStore.get(name);
			if (!cache) throw new Error(`cache ${name} was never opened`);
			return cache;
		},
		seed(name, entries) {
			const cache = new FakeCache();
			for (const [url, body] of Object.entries(entries)) {
				cache.entries.set(url, body);
			}
			cacheStore.set(name, cache);
			return cache;
		},
		async dispatchFetch(req) {
			let responded: Promise<FakeResponse> | undefined;
			const waits: Promise<unknown>[] = [];
			for (const handler of handlersFor("fetch")) {
				handler({
					request: req,
					respondWith: (value: Promise<FakeResponse>) => {
						responded = value;
					},
					waitUntil: (value: Promise<unknown>) => {
						waits.push(value);
					},
				});
			}
			// Undefined when the worker declined to intercept, which is itself an
			// observable — an un-cached route must not be handled at all.
			const result = responded ? await responded : undefined;
			// Await the registered background work rather than counting microtasks: a
			// bare `await Promise.resolve()` is tied to the fake's timing, so one extra
			// `await` inside the revalidation chain would stop reaching the eviction.
			await Promise.all(waits);
			return result;
		},
		async activate() {
			const waits: Promise<unknown>[] = [];
			for (const handler of handlersFor("activate")) {
				handler({
					waitUntil: (value: Promise<unknown>) => {
						waits.push(value);
					},
				});
			}
			await Promise.all(waits);
		},
	};
}

describe("service worker takedown eviction (#556)", () => {
	let sw: Harness;

	beforeEach(() => {
		sw = loadServiceWorker();
	});

	afterEach(() => {
		// Both directions, so over- and under-fetching are visible.
		expect(
			sw.nextFetch,
			"a queued fetch result went unused — the worker fetched fewer times than the test expected",
		).toHaveLength(0);
		expect(
			sw.surplusFetches,
			"the worker fetched more times than the test queued",
		).toBe(0);
	});

	// --- controls the eviction assertions depend on -------------------------------

	it("caches a meeting page while online", async () => {
		sw.nextFetch.push(response(200, "live agenda"));
		const res = await sw.dispatchFetch(request(MEETING));
		expect(res?.status).toBe(200);
		expect([...sw.cacheFor("gavelup-nav-v4").entries.values()]).toEqual([
			"live agenda",
		]);
	});

	it("serves the cached copy when the network is down", async () => {
		sw.nextFetch.push(response(200, "live agenda"));
		await sw.dispatchFetch(request(MEETING));
		sw.nextFetch.push(new Error("offline"));
		const offline = await sw.dispatchFetch(request(MEETING));
		expect(offline?.body).toBe("live agenda");
	});

	it("does not intercept a non-meeting navigation, a POST, or another origin", async () => {
		// The un-intercepted path is the security-relevant one: it is what keeps
		// authed non-meeting pages out of the on-device cache (#176's
		// single-user-device assumption). A widened matcher would start caching them.
		expect(await sw.dispatchFetch(request("/club/acme"))).toBeUndefined();
		expect(await sw.dispatchFetch(request("/dashboard"))).toBeUndefined();
		expect(
			await sw.dispatchFetch(request(MEETING, { method: "POST" })),
		).toBeUndefined();
		expect(
			await sw.dispatchFetch({
				url: "https://evil.example/club/acme/meeting/x",
				method: "GET",
				mode: "navigate",
				destination: "",
			}),
		).toBeUndefined();
		expect(sw.caches.size).toBe(0);
	});

	// --- the eviction itself ------------------------------------------------------

	it.each([
		404, 410,
	])("evicts the cached agenda on a %i takedown", async (status) => {
		sw.nextFetch.push(response(200, "pre-archive agenda"));
		await sw.dispatchFetch(request(MEETING));
		const nav = sw.cacheFor("gavelup-nav-v4");
		expect(nav.entries.size).toBe(1);

		sw.nextFetch.push(response(status, "gone"));
		await sw.dispatchFetch(request(MEETING));
		expect(nav.entries.size).toBe(0);

		// And an offline reload has nothing left to serve.
		sw.nextFetch.push(new Error("offline"));
		await expect(sw.dispatchFetch(request(MEETING))).rejects.toThrow(/offline/);
	});

	it.each([
		401, 403, 500, 503,
	])("keeps the cached agenda through a %i — not every failure is a takedown", async (status) => {
		sw.nextFetch.push(response(200, "live agenda"));
		await sw.dispatchFetch(request(MEETING));
		const nav = sw.cacheFor("gavelup-nav-v4");

		sw.nextFetch.push(response(status, "nope"));
		await sw.dispatchFetch(request(MEETING));
		expect([...nav.entries.values()]).toEqual(["live agenda"]);

		// Still there for the room mid-meeting.
		sw.nextFetch.push(new Error("offline"));
		expect((await sw.dispatchFetch(request(MEETING)))?.body).toBe(
			"live agenda",
		);
	});

	it("ignores a 404 that came from a redirect — a captive portal is not a takedown", async () => {
		sw.nextFetch.push(response(200, "live agenda"));
		await sw.dispatchFetch(request(MEETING));
		const nav = sw.cacheFor("gavelup-nav-v4");

		// Venue wifi bounces the request to a login page which answers 404.
		sw.nextFetch.push(
			response(404, "portal", {
				redirected: true,
				url: "https://wifi.venue.example/login",
			}),
		);
		await sw.dispatchFetch(request(MEETING));
		expect([...nav.entries.values()]).toEqual(["live agenda"]);
	});

	it("evicts EVERY surface of the taken-down meeting, not just the URL that 404'd", async () => {
		// One meeting occupies three keys. A device that primed all three would keep
		// answering offline reloads from the two it did not re-request.
		sw.nextFetch.push(response(200, "agenda"));
		await sw.dispatchFetch(request(MEETING));
		sw.nextFetch.push(response(200, "present deck"));
		await sw.dispatchFetch(request(`${MEETING}/present`));
		sw.nextFetch.push(response(200, "grid sheet"));
		await sw.dispatchFetch(request(`${MEETING}/print?layout=grid`));
		sw.nextFetch.push(response(200, "column sheet"));
		await sw.dispatchFetch(request(`${MEETING}/print?layout=columns`));
		const nav = sw.cacheFor("gavelup-nav-v4");
		expect(nav.entries.size).toBe(4);

		// The takedown 404 lands on ONE layout of ONE surface (the print route 307s
		// to ?layout=grid, so that is what a reload hits).
		sw.nextFetch.push(response(404, "gone"));
		await sw.dispatchFetch(request(`${MEETING}/print?layout=grid`));
		expect(nav.entries.size).toBe(0);
	});

	it("does not evict a DIFFERENT meeting or club", async () => {
		const other = "/club/acme/meeting/2026-02-09-1900";
		const otherClub = "/club/harbor/meeting/2026-01-05-1900";
		sw.nextFetch.push(response(200, "ours"));
		await sw.dispatchFetch(request(`${MEETING}/print?layout=grid`));
		sw.nextFetch.push(response(200, "next month"));
		await sw.dispatchFetch(request(other));
		sw.nextFetch.push(response(200, "another club"));
		await sw.dispatchFetch(request(otherClub));
		const nav = sw.cacheFor("gavelup-nav-v4");

		sw.nextFetch.push(response(404, "gone"));
		await sw.dispatchFetch(request(`${MEETING}/print?layout=grid`));
		expect([...nav.entries.values()].sort()).toEqual([
			"another club",
			"next month",
		]);
	});

	// --- the club crest in the asset cache ---------------------------------------

	it("evicts every ?v= revision of a taken-down club's crest", async () => {
		// `clubLogoUrl` always emits `?v=<epochMs>`, so a crest replaced before the
		// takedown leaves more than one cached revision. The 404 arrives on whichever
		// one the page currently references.
		sw.nextFetch.push(response(200, "old crest"));
		await sw.dispatchFetch(request(LOGO_V1, AS_IMAGE));
		sw.nextFetch.push(response(200, "new crest"));
		await sw.dispatchFetch(request(LOGO_V2, AS_IMAGE));
		const assets = sw.cacheFor("gavelup-assets-v3");
		expect(assets.entries.size).toBe(2);

		sw.nextFetch.push(response(404, "gone"));
		await sw.dispatchFetch(request(LOGO_V2, AS_IMAGE));
		expect(assets.entries.size).toBe(0);
	});

	it("evicts a 404'd build asset exactly, without scanning by search", async () => {
		// A stale hashed chunk 404s routinely after a deploy. That entry should go,
		// but `ignoreSearch` must not be used here — the asset cache is unbounded, so
		// it would force a full enumeration on a routine event.
		sw.nextFetch.push(response(200, "chunk a"));
		await sw.dispatchFetch(
			request("/_build/assets/app-abc123.js", {
				mode: "no-cors",
				destination: "script",
			}),
		);
		const assets = sw.cacheFor("gavelup-assets-v3");
		expect(assets.entries.size).toBe(1);

		sw.nextFetch.push(response(404, "gone"));
		await sw.dispatchFetch(
			request("/_build/assets/app-abc123.js", {
				mode: "no-cors",
				destination: "script",
			}),
		);
		expect(assets.entries.size).toBe(0);
	});

	// --- activation sweep ---------------------------------------------------------

	it("drops the previous nav cache but KEEPS the asset cache, purging crests from it", async () => {
		// v3 is the nav version that shipped without eviction, so entries under it are
		// exactly the copies still sitting on devices (#556). The asset cache is not
		// bumped: dropping hashed build output removes nothing a takedown cares about
		// and costs every device a re-download.
		sw.seed("gavelup-nav-v3", {
			[`${ORIGIN}${MEETING}`]: "pre-archive agenda",
		});
		sw.seed("gavelup-assets-v3", {
			[`${ORIGIN}${LOGO_V1}`]: "crest",
			[`${ORIGIN}/_build/assets/app-abc123.js`]: "chunk",
		});
		sw.seed("unrelated-cache", {});

		await sw.activate();

		expect([...sw.caches.keys()]).not.toContain("gavelup-nav-v3");
		expect([...sw.caches.keys()]).toContain("gavelup-assets-v3");
		// Only gavelup-* caches are ours to drop.
		expect([...sw.caches.keys()]).toContain("unrelated-cache");
		// The crest is gone; the hashed chunk survives.
		expect([...sw.cacheFor("gavelup-assets-v3").entries.values()]).toEqual([
			"chunk",
		]);
	});
});

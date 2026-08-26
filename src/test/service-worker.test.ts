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
	/** `primeAssetsOf` reads a primed document's HTML to find its scripts. */
	text(): Promise<string>;
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
		text: async () => res.body,
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

	// Takes a URL string as well as a Request for the same reason `put` does —
	// the real Cache API accepts both, and `primeAssetsOf`'s already-cached
	// check (#362) passes the string form.
	async match(
		req: FakeRequest | string,
		options?: { ignoreSearch?: boolean },
	): Promise<FakeResponse | undefined> {
		const url = typeof req === "string" ? req : req.url;
		const exact = this.entries.get(url);
		if (exact !== undefined) return response(200, exact, { url });
		if (!options?.ignoreSearch) return undefined;
		const base = withoutSearch(url);
		for (const [cached, body] of this.entries) {
			if (withoutSearch(cached) === base) {
				return response(200, body, { url: cached });
			}
		}
		return undefined;
	}

	// Accepts a URL STRING as well as a Request, because the real Cache API does
	// and `primeOpenMeetingPages` (#362) uses the string form — sw.js constructs
	// no Request anywhere, so this harness injects none.
	async put(req: FakeRequest | string, res: FakeResponse): Promise<void> {
		this.entries.set(typeof req === "string" ? req : req.url, res.body);
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
	/** Every fetch the worker made, with the cache mode it requested (#517). */
	fetchInits: { url: string; cache?: string }[];
	/** Window URLs the worker controls at activation (#362) — set before calling
	 *  `activate()`, which is when the priming pass reads them. */
	openClients: string[];
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
	const state = {
		surplus: 0,
		/** Window URLs this worker controls at activation (#362). */
		openClients: [] as string[],
		lastInit: [] as { url: string; cache?: string }[],
	};

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
		clients: {
			claim: async () => {},
			// The windows this worker controls, for the activation-time priming in
			// #362. Tests set `harness.openClients` before calling `activate()`.
			matchAll: async () => state.openClients.map((url) => ({ url })),
		},
		location: { origin: ORIGIN },
	};

	const fetchApi = async (
		req: FakeRequest,
		init?: { cache?: string },
	): Promise<FakeResponse> => {
		// Recorded so a test can assert the crest revalidates PAST the HTTP cache
		// (#517). Without it, `fetch(request, { cache: "no-cache" })` and a plain
		// `fetch(request)` are indistinguishable here, and the assertion that the
		// eviction is reachable at all would be untestable.
		state.lastInit.push({ url: req.url, cache: init?.cache });
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
		/** Every fetch this worker made, with the cache mode it asked for. */
		get fetchInits() {
			return state.lastInit;
		},
		get openClients() {
			return state.openClients;
		},
		set openClients(urls: string[]) {
			state.openClients = urls;
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

	/**
	 * Queue the sibling surfaces an ONLINE meeting navigation now primes (#362).
	 *
	 * Since v1.25.9.0 a successful meeting-page load fans out to that meeting's
	 * other surfaces, so a fixture that queues only the navigation itself
	 * under-feeds the worker and the `surplusFetches` guard below fails. Priming
	 * skips the surface actually requested, so pass the ones expected back:
	 * a meeting-page load primes two, a `/word` or `/vote` load primes all three.
	 *
	 * Bodies are distinct and named so an assertion that accidentally sweeps a
	 * primed entry in reads as an obvious wrong value rather than as a count.
	 */
	function primes(...labels: string[]) {
		for (const label of labels) {
			sw.nextFetch.push(response(200, `primed ${label}`));
		}
	}

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
		primes("present", "print");
		const res = await sw.dispatchFetch(request(MEETING));
		expect(res?.status).toBe(200);
		// Three keys, not one: opening a meeting online now caches the meeting a
		// club actually uses, which is all of it. The eviction cases below used to
		// build that state by hand; it is the system's own behaviour now.
		expect([...sw.cacheFor("gavelup-nav-v4").entries.values()].sort()).toEqual([
			"live agenda",
			"primed present",
			"primed print",
		]);
	});

	it("serves the cached copy when the network is down", async () => {
		sw.nextFetch.push(response(200, "live agenda"));
		primes("present", "print");
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
		primes("present", "print");
		await sw.dispatchFetch(request(MEETING));
		const nav = sw.cacheFor("gavelup-nav-v4");
		expect(nav.entries.size).toBe(3);

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
		primes("present", "print");
		await sw.dispatchFetch(request(MEETING));
		const nav = sw.cacheFor("gavelup-nav-v4");

		// A non-ok response primes nothing — priming hangs off the `ok` branch, so
		// a 500 cannot spend three requests re-asking a struggling server.
		sw.nextFetch.push(response(status, "nope"));
		await sw.dispatchFetch(request(MEETING));
		expect(nav.entries.get(`${ORIGIN}${MEETING}`)).toBe("live agenda");

		// Still there for the room mid-meeting.
		sw.nextFetch.push(new Error("offline"));
		expect((await sw.dispatchFetch(request(MEETING)))?.body).toBe(
			"live agenda",
		);
	});

	// Two INDEPENDENT narrowings, so two fixtures. One case setting both
	// `redirected: true` and a foreign origin would pass with either guard deleted.
	it("ignores a REDIRECTED 404 — a captive portal is not a takedown", async () => {
		sw.nextFetch.push(response(200, "live agenda"));
		primes("present", "print");
		await sw.dispatchFetch(request(MEETING));
		const nav = sw.cacheFor("gavelup-nav-v4");

		// Venue wifi bounces the request to a login page. Same origin on the way back,
		// so only the `redirected` flag separates this from a real takedown.
		sw.nextFetch.push(
			response(404, "portal", { redirected: true, url: `${ORIGIN}${MEETING}` }),
		);
		await sw.dispatchFetch(request(MEETING));
		expect(nav.entries.get(`${ORIGIN}${MEETING}`)).toBe("live agenda");
	});

	it("ignores a 404 answered by another origin", async () => {
		sw.nextFetch.push(response(200, "live agenda"));
		primes("present", "print");
		await sw.dispatchFetch(request(MEETING));
		const nav = sw.cacheFor("gavelup-nav-v4");

		// Not flagged as redirected — only the origin says this did not come from us.
		sw.nextFetch.push(
			response(404, "portal", { url: "https://wifi.venue.example/login" }),
		);
		await sw.dispatchFetch(request(MEETING));
		expect(nav.entries.get(`${ORIGIN}${MEETING}`)).toBe("live agenda");
	});

	it("evicts EVERY surface of the taken-down meeting, not just the URL that 404'd", async () => {
		// One meeting occupies three keys. A device that primed all three would keep
		// answering offline reloads from the two it did not re-request.
		sw.nextFetch.push(response(200, "agenda"));
		primes("present", "print");
		await sw.dispatchFetch(request(MEETING));
		// Each of these overwrites what priming had just put there, and primes the
		// two surfaces it is not. `/print?layout=grid` primes only the meeting page
		// and Present — NOT a bare `/print`, which is the same path it is already
		// serving; that skip is by pathname, not by href.
		sw.nextFetch.push(response(200, "present deck"));
		primes("meeting", "print");
		await sw.dispatchFetch(request(`${MEETING}/present`));
		sw.nextFetch.push(response(200, "grid sheet"));
		primes("meeting", "present");
		await sw.dispatchFetch(request(`${MEETING}/print?layout=grid`));
		sw.nextFetch.push(response(200, "column sheet"));
		primes("meeting", "present");
		await sw.dispatchFetch(request(`${MEETING}/print?layout=columns`));
		const nav = sw.cacheFor("gavelup-nav-v4");
		// Four requested surfaces plus the bare `/print` priming reached.
		expect(nav.entries.size).toBe(5);

		// The takedown 404 lands on ONE layout of ONE surface (the print route 307s
		// to ?layout=grid, so that is what a reload hits).
		sw.nextFetch.push(response(404, "gone"));
		await sw.dispatchFetch(request(`${MEETING}/print?layout=grid`));
		expect(nav.entries.size).toBe(0);
	});

	it("evicts the Word of the Day and the live ballot too, not just the three obvious surfaces", async () => {
		// `isOfflineRoute` caches ANYTHING under /club/<slug>/meeting/<key>/, and
		// /word and /vote are real routes. The first version of `meetingPrefix`
		// stripped a hardcoded /present|/print, so a takedown evicted the agenda and
		// left the poster and the live ballot answering offline reloads — the fixture
		// had been built from a code comment rather than from the route list.
		sw.nextFetch.push(response(200, "agenda"));
		primes("present", "print");
		await sw.dispatchFetch(request(MEETING));
		// `/word` and `/vote` are not themselves in the primed set, so each primes
		// all THREE of the meeting's surfaces rather than two.
		sw.nextFetch.push(response(200, "word poster"));
		primes("meeting", "present", "print");
		await sw.dispatchFetch(request(`${MEETING}/word`));
		sw.nextFetch.push(response(200, "live ballot"));
		primes("meeting", "present", "print");
		await sw.dispatchFetch(request(`${MEETING}/vote`));
		const nav = sw.cacheFor("gavelup-nav-v4");
		// agenda + word + vote + the primed present/print.
		expect(nav.entries.size).toBe(5);

		sw.nextFetch.push(response(404, "gone"));
		await sw.dispatchFetch(request(MEETING));
		expect(nav.entries.size).toBe(0);
	});

	it("evicts the legacy /meetings/<id> surface", async () => {
		// Matched by `isOfflineRoute` and named in sw.js's header, previously driven by
		// no test at all. It is its own cache key, not a surface of a club-scoped path.
		const legacy = "/meetings/11111111-1111-1111-1111-111111111111";
		sw.nextFetch.push(response(200, "legacy redirect page"));
		await sw.dispatchFetch(request(legacy));
		const nav = sw.cacheFor("gavelup-nav-v4");
		expect(nav.entries.size).toBe(1);

		sw.nextFetch.push(response(404, "gone"));
		await sw.dispatchFetch(request(legacy));
		expect(nav.entries.size).toBe(0);
	});

	it("does not evict a DIFFERENT meeting or club", async () => {
		const other = "/club/acme/meeting/2026-02-09-1900";
		const otherClub = "/club/harbor/meeting/2026-01-05-1900";
		sw.nextFetch.push(response(200, "ours"));
		primes("meeting", "present");
		await sw.dispatchFetch(request(`${MEETING}/print?layout=grid`));
		sw.nextFetch.push(response(200, "next month"));
		primes("other present", "other print");
		await sw.dispatchFetch(request(other));
		sw.nextFetch.push(response(200, "another club"));
		primes("harbor present", "harbor print");
		await sw.dispatchFetch(request(otherClub));
		const nav = sw.cacheFor("gavelup-nav-v4");

		sw.nextFetch.push(response(404, "gone"));
		await sw.dispatchFetch(request(`${MEETING}/print?layout=grid`));
		// Every key of the taken-down meeting is gone, including the two priming
		// added; both other meetings keep all three of theirs.
		expect([...nav.entries.values()].sort()).toEqual([
			"another club",
			"next month",
			"primed harbor present",
			"primed harbor print",
			"primed other present",
			"primed other print",
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

	/**
	 * #517. The eviction above was UNREACHABLE on a real device until this, and
	 * nothing here could see it: a plain `fetch` is served by the browser's HTTP
	 * cache, and the logo route answered `max-age=31536000, immutable` — so the
	 * revalidation never left the machine, `response.ok` stayed true, and
	 * `isGoneResponse` could not fire. Every test above passes with or without
	 * that, because this harness has no HTTP cache to be served by.
	 *
	 * So assert the REQUEST, not the outcome: the crest must revalidate with
	 * `cache: "no-cache"`, which is what forces a conditional request to the
	 * origin and lets a 404 reach the eviction. `no-cache`, not `reload` — the
	 * route now sends an ETag, so the normal answer is a bodiless 304.
	 */
	it("revalidates the crest past the HTTP cache, so a 404 can reach the eviction", async () => {
		sw.nextFetch.push(response(200, "crest"));
		await sw.dispatchFetch(request(LOGO_V1, AS_IMAGE));
		const logoFetch = sw.fetchInits.find((f) => f.url.includes("/logo"));
		expect(logoFetch, "the worker made no fetch for the crest").toBeTruthy();
		expect(logoFetch?.cache).toBe("no-cache");
	});

	/**
	 * The other half, and the reason this is scoped rather than applied to the
	 * whole asset cache: build output is hashed, so its URL changes on every
	 * deploy and it can never go stale. A conditional request per asset would be
	 * pure cost for no takedown benefit.
	 */
	it("does NOT force revalidation for hashed build assets", async () => {
		sw.nextFetch.push(response(200, "chunk"));
		await sw.dispatchFetch(
			request("/assets/app-abc123.js", { mode: "cors", destination: "script" }),
		);
		const assetFetch = sw.fetchInits.find((f) => f.url.includes("app-abc123"));
		expect(assetFetch, "the worker made no fetch for the asset").toBeTruthy();
		expect(assetFetch?.cache).toBeUndefined();
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

/**
 * One online load is enough to prime a page (#362).
 *
 * THE reported bug, from a live meeting: the agenda was loaded online, wifi was
 * cut, the reload failed. None of the three suspects in #362 was the cause. The
 * mechanism is the worker UPDATE itself — the load was served by the previous
 * worker, which cached the document under the previous `NAV_CACHE` name, and the
 * new worker's activation sweep then deleted that cache as unowned. So the nav
 * cache was empty at the moment it was needed, `networkFirst` rethrew, and the
 * browser showed its own error page. #556's v3 → v4 bump and every later edit to
 * `sw.js` each open exactly that window.
 *
 * The FIRST-VISIT variant lands in the same place for a different reason:
 * `registerServiceWorker` runs on `load`, so the document that triggers
 * registration is fetched before any worker exists and is never intercepted.
 *
 * Both mean "prime it before the meeting" silently does nothing, which is worse
 * than having no offline mode, because the club believes it is covered.
 */
describe("priming on activation (#362)", () => {
	let sw: Harness;
	beforeEach(() => {
		sw = loadServiceWorker();
	});

	/** Prime with a distinct body per surface, so a mix-up is visible. */
	function queueThreeSurfaces() {
		sw.nextFetch.push(response(200, "AGENDA", { url: `${ORIGIN}${MEETING}` }));
		sw.nextFetch.push(
			response(200, "DECK", { url: `${ORIGIN}${MEETING}/present` }),
		);
		sw.nextFetch.push(
			// Print 307s to its default layout; the worker follows and keys the
			// FINAL url.
			response(200, "SHEET", {
				url: `${ORIGIN}${MEETING}/print?layout=grid`,
				redirected: true,
			}),
		);
	}

	it("caches all three meeting surfaces when a NEW worker takes over", async () => {
		// The previous worker had cached the page under the old nav version.
		sw.seed("gavelup-nav-v3", { [`${ORIGIN}${MEETING}`]: "OLD AGENDA" });
		sw.openClients = [`${ORIGIN}${MEETING}`];
		queueThreeSurfaces();

		await sw.activate();

		// The old cache is gone, as it should be — but the CURRENT one now holds
		// the meeting, so the user has not lost offline access by updating.
		expect(sw.caches.has("gavelup-nav-v3")).toBe(false);
		const entries = sw.cacheFor("gavelup-nav-v4").entries;
		// ALL THREE, not just the open one. `evict` has always treated a meeting as
		// three keys; priming treated it as one, and that asymmetry is why Present
		// still failed offline after the meeting page was fixed.
		expect(entries.get(`${ORIGIN}${MEETING}`)).toBe("AGENDA");
		expect(entries.get(`${ORIGIN}${MEETING}/present`)).toBe("DECK");
		expect(entries.get(`${ORIGIN}${MEETING}/print?layout=grid`)).toBe("SHEET");
	});

	it("serves Present offline after priming from the meeting page — the second repro", async () => {
		// The reported sequence, exactly: open the meeting online, cut wifi,
		// reload (works since v1.22.7.0), then click Present. That link is
		// `target="_blank"`, so it is a real navigation the worker sees — into a
		// URL nothing had primed.
		sw.openClients = [`${ORIGIN}${MEETING}`];
		queueThreeSurfaces();
		await sw.activate();
		expect(sw.nextFetch, "activation did not prime all three").toHaveLength(0);

		sw.nextFetch.push(new Error("offline"));
		const served = await sw.dispatchFetch(request(`${MEETING}/present`));
		expect(served?.body).toBe("DECK");
	});

	it("primes Print under its redirected layout, and serves a bare /print from it", async () => {
		sw.openClients = [`${ORIGIN}${MEETING}`];
		queueThreeSurfaces();
		await sw.activate();

		// A bare `/…/print` request offline finds the `?layout=grid` entry through
		// `networkFirst`'s ignoreSearch fallback — which is why keying by the final
		// url is right rather than by the url we asked for.
		sw.nextFetch.push(new Error("offline"));
		const served = await sw.dispatchFetch(request(`${MEETING}/print`));
		expect(served?.body).toBe("SHEET");
	});

	it("serves that page offline afterwards — the reported repro, end to end", async () => {
		sw.openClients = [`${ORIGIN}${MEETING}`];
		queueThreeSurfaces();
		await sw.activate();

		// The queue MUST be drained here, and asserting it is what makes the rest
		// of this case mean anything. Caught by mutation: with the priming call
		// removed, activation makes no fetch, the queued 200 survives into the
		// phase below, and the "offline" reload is answered from the NETWORK — so
		// the test passed while the bug it exists for was live. `nextFetch` is a
		// shared queue across phases, which is exactly the trap.
		expect(
			sw.nextFetch,
			"activation did not fetch — nothing was primed",
		).toHaveLength(0);

		// Wifi cut, reload.
		sw.nextFetch.push(new Error("offline"));
		const served = await sw.dispatchFetch(request(MEETING));
		expect(served?.body).toBe("AGENDA");
	});

	it("primes nothing for a client that is not on an offline route", async () => {
		// Scoped exactly as `isOfflineRoute` scopes the fetch handler: this cache is
		// for meeting pages, and priming the dashboard would put unrelated authed
		// pages into it.
		sw.openClients = [`${ORIGIN}/schedule`];
		await sw.activate();
		expect(sw.cacheFor("gavelup-nav-v4").entries.size).toBe(0);
		expect(sw.surplusFetches).toBe(0);
	});

	it("survives activating while already offline", async () => {
		// Nothing to prime from, and the old cache is gone regardless — but the
		// activation must not reject, or the worker never takes control at all.
		sw.openClients = [`${ORIGIN}${MEETING}`];
		for (let i = 0; i < 3; i++) sw.nextFetch.push(new Error("offline"));
		await expect(sw.activate()).resolves.toBeUndefined();
		expect(sw.cacheFor("gavelup-nav-v4").entries.size).toBe(0);
	});

	it("does not cache a captive portal's redirected 200 over the agenda", async () => {
		// Venue wifi. `isGoneResponse` already refuses to treat a redirected
		// response as a takedown; the priming path must equally refuse to treat one
		// as an agenda, or the step meant to protect the offline copy destroys it.
		sw.openClients = [`${ORIGIN}${MEETING}`];
		for (let i = 0; i < 3; i++) {
			sw.nextFetch.push(
				response(200, "PORTAL LOGIN", {
					redirected: true,
					url: `${ORIGIN}/login`,
				}),
			);
		}
		await sw.activate();
		// The DESTINATION is what disqualifies it, not the redirect: `/login` is not
		// an offline route. Print's 307 to `?layout=grid` lands on one and is kept,
		// which is the distinction `!response.redirected` could not make.
		expect(sw.cacheFor("gavelup-nav-v4").entries.size).toBe(0);
	});
});

/**
 * #362, third pass — priming on a VISIT rather than only on activation.
 *
 * The whole reason a second fix was needed. Activation priming (v1.25.8.0)
 * covers exactly one load: the one where the worker updates. `activate` does not
 * fire again, so on every NORMAL visit — a current worker, which is the state a
 * user is in essentially always — nothing primed anything, and clicking Present
 * offline still hit the browser's network-error page. The reported repro was run
 * against a deploy that already contained the activation fix and still failed.
 *
 * So every case here deliberately does NOT call `activate()`. That absence is
 * the fixture: it models the already-current worker, which is the state the
 * previous fix could not reach and this one has to.
 */
describe("meeting priming on a visit, not only on activation (#362)", () => {
	let sw: Harness;

	beforeEach(() => {
		sw = loadServiceWorker();
	});

	it("serves Present offline after only ever VISITING the meeting page", async () => {
		// The user's repro, against a worker that is already current.
		sw.nextFetch.push(response(200, "AGENDA"));
		sw.nextFetch.push(
			response(200, "DECK", { url: `${ORIGIN}${MEETING}/present` }),
		);
		sw.nextFetch.push(
			response(200, "SHEET", { url: `${ORIGIN}${MEETING}/print` }),
		);
		await sw.dispatchFetch(request(MEETING));

		// Same trap as the activation case: `nextFetch` is shared across phases, so
		// without draining it a queued 200 leaks into the offline phase and answers
		// from the NETWORK. Caught by mutation — with the priming call removed this
		// assertion is what fails rather than the one below silently passing.
		expect(
			sw.nextFetch,
			"the visit primed nothing — no worker update was involved",
		).toHaveLength(0);

		sw.nextFetch.push(new Error("offline"));
		const served = await sw.dispatchFetch(request(`${MEETING}/present`));
		expect(served?.body).toBe("DECK");
	});

	it("primes nothing when the meeting page itself failed", async () => {
		// Priming hangs off the `ok` branch. A club whose server is down must not
		// have one failed navigation turned into three.
		sw.nextFetch.push(response(500, "boom"));
		await sw.dispatchFetch(request(MEETING));
		expect(sw.surplusFetches).toBe(0);
		expect(sw.cacheFor("gavelup-nav-v4").entries.size).toBe(0);
	});

	it("primes nothing while offline — the reload that serves from cache", async () => {
		sw.nextFetch.push(new Error("offline"));
		sw.seed("gavelup-nav-v4", { [`${ORIGIN}${MEETING}`]: "AGENDA" });
		const served = await sw.dispatchFetch(request(MEETING));
		expect(served?.body).toBe("AGENDA");
		// An offline reload must not spend three more failing requests.
		expect(sw.surplusFetches).toBe(0);
	});

	it("does not re-fetch the surface being served, comparing by PATH not href", async () => {
		// `/…/print` 307s to `?layout=grid`, so the request that reaches the worker
		// carries a query the bare surface list does not. Matching on href would
		// make Print re-fetch itself on every load.
		sw.nextFetch.push(response(200, "SHEET"));
		sw.nextFetch.push(response(200, "AGENDA", { url: `${ORIGIN}${MEETING}` }));
		sw.nextFetch.push(
			response(200, "DECK", { url: `${ORIGIN}${MEETING}/present` }),
		);
		await sw.dispatchFetch(request(`${MEETING}/print?layout=grid`));
		expect(sw.nextFetch).toHaveLength(0);
		expect(sw.surplusFetches).toBe(0);
	});
});

/**
 * #362, and the half that decides whether a primed page WORKS.
 *
 * `fetch(href)` retrieves a document and nothing else — the browser is what
 * normally requests a page's scripts, and `staleWhileRevalidate` only caches an
 * asset something already asked for. So Present primed as a document alone comes
 * back offline as un-hydrated SSR output: the first slide, and no way to advance
 * it. Which on the night is its own bug report, filed against the fix.
 */
describe("priming a document also primes its build assets (#362)", () => {
	let sw: Harness;
	const CHUNK = "/_build/assets/present-ab12cd.js";
	const SHEET = "/assets/deck-99ff00.css";

	const docWith = (...paths: string[]) =>
		paths.map((path) => `<script src="${path}"></script>`).join("");

	beforeEach(() => {
		sw = loadServiceWorker();
	});

	it("caches the scripts a primed Present page references", async () => {
		sw.nextFetch.push(response(200, "AGENDA"));
		sw.nextFetch.push(
			response(200, docWith(CHUNK, SHEET), {
				url: `${ORIGIN}${MEETING}/present`,
			}),
		);
		sw.nextFetch.push(response(200, "CHUNK"));
		sw.nextFetch.push(response(200, "SHEET"));
		sw.nextFetch.push(
			response(200, "PRINT", { url: `${ORIGIN}${MEETING}/print` }),
		);
		await sw.dispatchFetch(request(MEETING));

		const assets = sw.cacheFor("gavelup-assets-v3").entries;
		expect(assets.get(`${ORIGIN}${CHUNK}`)).toBe("CHUNK");
		expect(assets.get(`${ORIGIN}${SHEET}`)).toBe("SHEET");
	});

	it("skips an asset already held — hashed paths cannot go stale", async () => {
		// This is what keeps priming on EVERY visit affordable: the documents are
		// re-fetched for freshness, the (content-hashed) assets are not.
		sw.seed("gavelup-assets-v3", { [`${ORIGIN}${CHUNK}`]: "CHUNK" });
		sw.nextFetch.push(response(200, "AGENDA"));
		sw.nextFetch.push(
			response(200, docWith(CHUNK), { url: `${ORIGIN}${MEETING}/present` }),
		);
		sw.nextFetch.push(
			response(200, "PRINT", { url: `${ORIGIN}${MEETING}/print` }),
		);
		await sw.dispatchFetch(request(MEETING));

		// No fourth fetch: the queue is exactly drained and nothing overran it.
		expect(sw.nextFetch).toHaveLength(0);
		expect(sw.surplusFetches).toBe(0);
		expect(
			sw.cacheFor("gavelup-assets-v3").entries.get(`${ORIGIN}${CHUNK}`),
		).toBe("CHUNK");
	});

	it("ignores another origin and any path that is not build output", async () => {
		// The same match set `isCacheableAsset` uses. An analytics script or a CDN
		// font must not be pulled into the club's offline cache by a regex.
		// Both filters, and the CROSSING of them. Caught by mutation: with only
		// `https://cdn.example/tracker.js` here, deleting the origin check changed
		// nothing — that path fails `ASSET_PATH` too, so the origin arm was never
		// the thing doing the work. A foreign origin whose path is SHAPED like
		// build output is the case only the origin check can refuse, and it is
		// also the realistic one (a CDN mirroring the same layout).
		const doc = docWith(
			"https://cdn.example/_build/assets/tracker-00ff11.js",
			"https://cdn.example/tracker.js",
			"/api/club/x/logo",
			"/dashboard",
			CHUNK,
		);
		sw.nextFetch.push(response(200, "AGENDA"));
		sw.nextFetch.push(
			response(200, doc, { url: `${ORIGIN}${MEETING}/present` }),
		);
		sw.nextFetch.push(response(200, "CHUNK"));
		sw.nextFetch.push(
			response(200, "PRINT", { url: `${ORIGIN}${MEETING}/print` }),
		);
		await sw.dispatchFetch(request(MEETING));

		expect([...sw.cacheFor("gavelup-assets-v3").entries.keys()]).toEqual([
			`${ORIGIN}${CHUNK}`,
		]);
	});

	it("stops at the per-document ceiling", async () => {
		// Bounded because this runs inside `waitUntil`, which the browser kills on
		// a wall clock — an unbounded loop there loses the documents too.
		const many = Array.from({ length: 200 }, (_, i) => `/_build/c${i}.js`);
		sw.nextFetch.push(response(200, "AGENDA"));
		sw.nextFetch.push(
			response(200, docWith(...many), { url: `${ORIGIN}${MEETING}/present` }),
		);
		for (let i = 0; i < 200; i++) sw.nextFetch.push(response(200, `C${i}`));
		await sw.dispatchFetch(request(MEETING));

		// An ABSOLUTE ceiling, not one stated relative to the constant it guards:
		// `toBeLessThanOrEqual(MAX_PRIMED_ASSETS)` would pass for every value of
		// MAX_PRIMED_ASSETS, including one that reintroduces the unbounded loop.
		expect(sw.cacheFor("gavelup-assets-v3").entries.size).toBe(60);
	});
});

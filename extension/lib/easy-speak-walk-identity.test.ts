/**
 * Who a page is for, and who may write (#1047, third review round).
 *
 *  - every fetched page is checked against the identity the walk started with, before it is
 *    parsed or stored: the user can switch club or account in another tab mid-walk;
 *  - every write to the store is fenced on still holding the lease, in one atomic step: a
 *    walker whose request outlived its lease writes nothing;
 *  - the identity is asked of the live server when the button is pressed, and a page load asks
 *    for it only when there is an export to decide about.
 * Run: cd extension && bunx vitest run lib/easy-speak-walk-identity.test.ts
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	FIXTURE_IDENTITY,
	asIdentity,
	clock,
	fixtureDoc,
	memoryStore,
	parseHtml,
	readFixture,
	setup,
	stripClock,
} from "./easy-speak-test-kit";
import {
	LEASE_TTL_MS,
	MIN_GAP_MS,
	type Identity,
	freshIdentity,
	identityAtLoad,
	identityFromDoc,
} from "./easy-speak-walk";

const at = (path: string) => `https://easy-speak.org/${path}`;
const otherClub: Identity = { ...FIXTURE_IDENTITY, esClubId: "9090" };
/** How many pages of the walk's first `n` requests reach the store: the evaluation batch (JSON under /api/) is staged in memory, and the closing fence is never stored. */
const stored = (walk: { stored: boolean }[], n: number) => walk.slice(0, n).filter((r) => r.stored).length;
const otherAccount: Identity = { ...FIXTURE_IDENTITY, username: "someoneelse" };

/**
 * The requests of one uninterrupted walk, in order. `stored` is false for what never reaches the
 * store: the API calls and the evaluations' closing check, the request forms (staged until their
 * fence) and the speech list asked again as that fence. `viewerless` marks the request forms, which
 * name no viewer and so cannot show an account switch until the fence.
 */
async function baseline() {
	const s = setup();
	await s.run();
	const paths = s.log.map((r) => new URL(r.url).pathname);
	return s.log.map((r, i) => {
		const html = !paths[i].startsWith("/api/");
		const viewerless = paths[i] === "/request_speech.php";
		const fence = paths[i] === "/tm_all_speeches.php" && paths.indexOf(paths[i]) !== i;
		return { url: r.url, html, viewerless, stored: html && !viewerless && !fence };
	});
}

describe("every page is for the account and club that started the walk", () => {
	for (const [what, other, message, marker] of [
		["account", otherAccount, /signed in as another account/, otherAccount.username],
		["club", otherClub, /showing another club/, `c=${otherClub.esClubId}`],
	] as const) {
		it(`aborts, and stores nothing of the response, when the ${what} switches before any one of the walk's pages`, async () => {
			const walk = await baseline();
			expect(walk.length).toBeGreaterThan(20);
			let checked = 0;
			for (const [i, req] of walk.entries()) {
				if (!req.html) continue;
				// A request form names no viewer: another account is seen only at the fence (own test in easy-speak-walk.test.ts).
				if (what === "account" && req.viewerless) continue;
				checked += 1;
				const store = memoryStore();
				const s = setup({ store, as: (idx) => (idx >= i ? other : FIXTURE_IDENTITY) });
				await expect(s.run(), `request ${i} ${req.url}`).rejects.toThrow(message);
				// It stopped on that page: nothing was asked for after it.
				expect(s.log).toHaveLength(i + 1);
				// Nothing of the other identity's page is in the store, under any key, and the pages
				// stored are exactly the ones fetched before it (the session's count agrees). The last
				// request is the fence after the evaluation requests, which are staged in memory and so
				// were never stored.
				const kept = stored(walk, i);
				expect(JSON.stringify([...store.data.entries()])).not.toContain(marker);
				expect([...store.data.keys()].filter((k) => k.startsWith("page:"))).toHaveLength(kept);
				expect((store.data.get("meta") as { pages: number }).pages).toBe(kept);
			}
			// Every HTML page the walk fetches was tried: the club page, lists, meetings, charts, the evaluations page.
			expect(checked).toBeGreaterThanOrEqual(19);
		});

		it(`does not call the evaluations page's switch of ${what} best-effort`, async () => {
			const s = setup({ as: (_i, url) => (url.endsWith("/my_evaluations.php") ? other : FIXTURE_IDENTITY) });
			await expect(s.run()).rejects.toThrow(message);
			expect(s.progress.some((l) => /evaluations skipped/.test(l))).toBe(false);
		});

		it(`resumes after switching back to the original ${what}: only the refused page is asked for again, and the bundle is the uninterrupted one`, async () => {
			const store = memoryStore();
			const first = setup({ store, as: (_i, url) => (url.endsWith("view_meeting.php?t=644304") ? other : FIXTURE_IDENTITY) });
			await expect(first.run()).rejects.toThrow(message);
			const second = setup({ store, clock: first.c });
			const resumed = await second.run();
			const again = second.log.map((r) => r.url);
			expect(again).toContain(at("view_meeting.php?t=644304"));
			expect(again).not.toContain(at("clubdata.php"));
			expect(again).not.toContain(at("view_meeting.php?t=644360"));
			const whole = await setup().run();
			// Same bundle, but for the clock: each page's fetch time and the export time.
			expect(stripClock(resumed)).toEqual(stripClock(whole));
		});
	}

	it("leaves a walk of one identity alone: the same account and club throughout asks for each page once, but for the two fences", async () => {
		const s = setup({ as: FIXTURE_IDENTITY });
		const { bundle } = await s.run();
		expect(bundle.meetings).toHaveLength(3);
		const urls = s.log.map((r) => `${r.method} ${r.url} ${r.body ?? ""}`);
		// Two pages are asked twice on purpose: the speech list closes the request forms, and the
		// evaluations page opens and closes the evaluation requests; neither batch can check the account itself.
		const twice = urls.filter((u, i) => urls.indexOf(u) !== i);
		expect(twice).toEqual([`GET ${at("tm_all_speeches.php")} `, `GET ${at("my_evaluations.php")} `]);
		expect(new Set(urls).size).toBe(urls.length - 2);
	});

	it("accepts a signed-in page that shows no club id (it cannot be another club's)", async () => {
		const s = setup({
			override: (url) =>
				url.endsWith("memberchart.php?chart=1")
					? readFixture("chart-1-role-history.html")
							.replace(/view_meeting\.php\?c=\d+/g, "view_meeting.php?show=next")
					: undefined,
		});
		const { archive } = await s.run();
		expect(archive.pages.some((r) => r.url.endsWith("chart=1"))).toBe(true);
	});

	it("identityFromDoc is null for a login page and reads the club and account of a club page", () => {
		expect(identityFromDoc(parseHtml("<html><body><form>Username</form></body></html>"))).toBeNull();
		expect(identityFromDoc(fixtureDoc("club-data.html"))).toEqual(FIXTURE_IDENTITY);
		expect(identityFromDoc(parseHtml(asIdentity(readFixture("club-data.html"), otherClub)))).toEqual(otherClub);
	});
});

describe("a walker that lost the lease writes nothing", () => {
	/** Another tab takes the lease and starts its own session, the moment request `at` is asked. */
	const theft = (store: ReturnType<typeof memoryStore>, c: ReturnType<typeof clock>, at: number) => {
		let n = 0;
		const successor = { startedAt: 1, lastActivityAt: 1, pages: 0, identity: otherClub };
		return (_url: string) => {
			if (n++ === at) {
				store.data.set("lease", { owner: "tab-b", expiresAt: c.now() + LEASE_TTL_MS });
				store.data.set("meta", successor);
			}
			return undefined;
		};
	};

	it("fails with a LeaseError and leaves the successor's session meta and pages as they were, whichever request outlived the lease", async () => {
		const walk = await baseline();
		const total = walk.length;
		// Not the last request: the fence after the evaluations stores nothing, so a walker that
		// loses the lease there has nothing left to refuse (see the test below).
		for (let at = 0; at < total - 1; at++) {
			const store = memoryStore();
			const c = clock();
			const s = setup({ store, clock: c, override: theft(store, c, at) });
			await expect(s.run(), `request ${at}`).rejects.toThrow(/took over this export/);
			// The successor's meta is exactly what it wrote, not this walker's session.
			expect(store.data.get("meta")).toEqual({ startedAt: 1, lastActivityAt: 1, pages: 0, identity: otherClub });
			// Pages stored are the ones finished before the theft: none for the request in flight, and
			// none of the staged evaluation requests.
			expect([...store.data.keys()].filter((k) => k.startsWith("page:"))).toHaveLength(stored(walk, at));
			expect(store.data.get("lease")).toMatchObject({ owner: "tab-b" });
		}
	});

	it("writes nothing and hands back the finished bundle when the lease is lost during the closing evaluations fence", async () => {
		const total = (await baseline()).length;
		const store = memoryStore();
		const c = clock();
		const { bundle } = await setup({ store, clock: c, override: theft(store, c, total - 1) }).run();
		expect(bundle.evaluations).toHaveLength(2);
		expect(store.data.get("meta")).toEqual({ startedAt: 1, lastActivityAt: 1, pages: 0, identity: otherClub });
		expect(store.data.get("lease")).toMatchObject({ owner: "tab-b" });
	});

	it("does not even clear the store when the lease was lost before the walk began", async () => {
		const store = memoryStore();
		const c = clock();
		const real = store.transact;
		let first = true;
		store.transact = async (keys, fn) => {
			if (first) {
				first = false;
				// Between taking the lease and the reset, another tab takes over and writes.
				store.data.set("lease", { owner: "tab-b", expiresAt: c.now() + LEASE_TTL_MS });
				store.data.set("page:from-tab-b", { url: "x", fetchedAt: "x", body: "b" });
			}
			return real(keys, fn);
		};
		const s = setup({ store, clock: c });
		await expect(s.run()).rejects.toThrow(/took over this export/);
		expect(store.data.has("page:from-tab-b")).toBe(true);
		expect(s.log).toEqual([]);
	});

	it("keeps the new owner's store when the lease is lost at the very end, and still hands back the finished bundle", async () => {
		// Count the store transactions of a whole walk; the last one is the cleanup.
		const probe = memoryStore();
		let count = 0;
		const probeReal = probe.transact;
		probe.transact = async (k, fn) => {
			count += 1;
			return probeReal(k, fn);
		};
		await setup({ store: probe }).run();

		const store = memoryStore();
		const c = clock();
		const real = store.transact;
		let n = 0;
		store.transact = async (keys, fn) => {
			n += 1;
			if (n === count) {
				store.data.set("lease", { owner: "tab-b", expiresAt: c.now() + LEASE_TTL_MS });
				store.data.set("page:from-tab-b", { url: "x", fetchedAt: "x", body: "b" });
			}
			return real(keys, fn);
		};
		const { bundle } = await setup({ store, clock: c }).run();
		expect(bundle.meetings).toHaveLength(3);
		expect(store.data.has("page:from-tab-b")).toBe(true);
		expect(store.data.get("lease")).toMatchObject({ owner: "tab-b" });
	});

	it("still cleans up after itself when it kept the lease", async () => {
		const store = memoryStore();
		await setup({ store }).run();
		expect([...store.data.keys()]).toEqual([]);
	});
});

describe("freshIdentity: asks the live server, and paces what follows", () => {
	const reply = (html: string) => async () => ({ ok: true, status: 200, text: async () => html });

	it("reads who the server says this is, whatever page was open", async () => {
		const urls: string[] = [];
		const id = await freshIdentity(
			async (url) => {
				urls.push(url);
				return { ok: true, status: 200, text: async () => asIdentity(readFixture("club-data.html"), otherAccount) };
			},
			parseHtml,
			async () => {},
		);
		expect(urls).toEqual([at("clubdata.php")]);
		expect(id).toEqual(otherAccount);
	});

	it("waits the walk's one-second gap after the request, so the next request keeps it", async () => {
		const slept: number[] = [];
		await freshIdentity(reply(readFixture("club-data.html")), parseHtml, async (ms) => void slept.push(ms));
		expect(slept).toEqual([MIN_GAP_MS]);
	});

	it("says so when it cannot tell, and still waits", async () => {
		const slept: number[] = [];
		const sleep = async (ms: number) => void slept.push(ms);
		await expect(freshIdentity(async () => ({ ok: false, status: 500, text: async () => "" }), parseHtml, sleep)).rejects.toThrow(
			/Could not read which club and account/,
		);
		await expect(freshIdentity(reply("<html><body><form>Username</form></body></html>"), parseHtml, sleep)).rejects.toThrow(
			/Could not read which club and account/,
		);
		await expect(
			freshIdentity(async () => {
				throw new Error("offline");
			}, parseHtml, sleep),
		).rejects.toThrow(/offline/);
		expect(slept).toEqual([MIN_GAP_MS, MIN_GAP_MS, MIN_GAP_MS]);
	});
});

describe("identityAtLoad: browsing costs no request", () => {
	const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
	const session = { startedAt: NOW - 1000, lastActivityAt: NOW - 1000, pages: 3, identity: FIXTURE_IDENTITY };
	const clubPageWithoutIds = () => parseHtml("<html><body><span class='name'><a>someone</a></span></body></html>");
	function spy() {
		const urls: string[] = [];
		return {
			urls,
			fetchImpl: async (url: string) => {
				urls.push(url);
				return { ok: true, status: 200, text: async () => readFixture("club-data.html") };
			},
		};
	}

	it("makes no request and reports nothing when nothing is stored and the page does not show who this is", async () => {
		const f = spy();
		const id = await identityAtLoad(clubPageWithoutIds(), memoryStore(), NOW, f.fetchImpl, parseHtml, async () => {});
		expect(id).toBeNull();
		expect(f.urls).toEqual([]);
	});

	it("makes no request when the page itself shows the club and the account, stored or not", async () => {
		const f = spy();
		const store = memoryStore();
		expect(await identityAtLoad(fixtureDoc("club-data.html"), store, NOW, f.fetchImpl, parseHtml, async () => {})).toEqual(FIXTURE_IDENTITY);
		await store.set("meta", session);
		expect(await identityAtLoad(fixtureDoc("club-data.html"), store, NOW, f.fetchImpl, parseHtml, async () => {})).toEqual(FIXTURE_IDENTITY);
		expect(f.urls).toEqual([]);
	});

	it("asks clubdata.php once, and waits, only when an export is stored and the page does not show who this is", async () => {
		const f = spy();
		const store = memoryStore();
		await store.set("meta", session);
		const slept: number[] = [];
		const id = await identityAtLoad(clubPageWithoutIds(), store, NOW, f.fetchImpl, parseHtml, async (ms) => void slept.push(ms));
		expect(id).toEqual(FIXTURE_IDENTITY);
		expect(f.urls).toEqual([at("clubdata.php")]);
		expect(slept).toEqual([MIN_GAP_MS]);
	});

	it("does not count an export too old to resume as one", async () => {
		const f = spy();
		const store = memoryStore();
		await store.set("meta", { ...session, lastActivityAt: NOW - 13 * 60 * 60 * 1000 });
		expect(await identityAtLoad(clubPageWithoutIds(), store, NOW, f.fetchImpl, parseHtml, async () => {})).toBeNull();
		expect(f.urls).toEqual([]);
	});
});

describe("the content script's wiring (the decisions above are tested; this keeps them connected)", () => {
	const source = readFileSync(new URL("../entrypoints/easyspeak.content.ts", import.meta.url), "utf8");

	it("hands the walk an identity asked of the server at the press, not one read off the page that was loaded", () => {
		expect(source).toContain("identity: await freshIdentity(fetchImpl, parseHtml, sleep)");
	});

	it("resolves identity at page load only through identityAtLoad, which makes no request for a browsing visit", () => {
		expect(source).toContain("identityAtLoad(document, store, Date.now(), fetchImpl, parseHtml, sleep)");
		expect(source).not.toContain("currentIdentity");
	});
});

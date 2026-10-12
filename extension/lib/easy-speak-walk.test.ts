/**
 * The Easy-Speak walk against the committed fixtures, served as a fake site
 * (`easy-speak-test-kit.ts`). Covers the acceptance criteria that are about
 * behaviour: one request at a time with a 1s gap, resume without re-fetching,
 * no contact pages in `raw`, and the expected bundle itself.
 * Run: cd extension && bunx vitest run lib/easy-speak-walk.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type EasySpeakBundleV1,
	isContactPage,
} from "./easy-speak-bundle";
import {
	type FakeRequest,
	fakeEasySpeak,
	fixturePath,
	parseHtml,
	readFixture,
} from "./easy-speak-test-kit";
import {
	MIN_GAP_MS,
	type WalkStore,
	readSession,
	runExport,
} from "./easy-speak-walk";

/** A memory store that survives "reloads": the same object is handed to the next run. */
function memoryStore(): WalkStore & { data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	return {
		data,
		get: async (k) => data.get(k),
		set: async (k, v) => {
			data.set(k, JSON.parse(JSON.stringify(v)));
		},
		clear: async () => data.clear(),
	};
}

/** A clock that only moves when the walk sleeps or a request "takes time". */
function clock(start = Date.UTC(2026, 9, 12, 12, 0, 0)) {
	let t = start;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		advance: (ms: number) => {
			t += ms;
		},
	};
}

function setup(opts: { failOn?: (url: string) => boolean; store?: ReturnType<typeof memoryStore> } = {}) {
	const c = clock();
	const log: FakeRequest[] = [];
	const store = opts.store ?? memoryStore();
	let inFlight = 0;
	let maxInFlight = 0;
	const site = fakeEasySpeak({ clock: c.now, log, failOn: opts.failOn });
	const fetchImpl = async (url: string, init: RequestInit) => {
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			const res = await site(url, init);
			// Let other microtasks run: a concurrent walk would overlap here.
			await Promise.resolve();
			c.advance(40);
			return res;
		} finally {
			inFlight -= 1;
		}
	};
	const run = () =>
		runExport({
			fetchImpl,
			parseHtml,
			store,
			sleep: c.sleep,
			now: c.now,
		});
	return { run, log, store, c, maxInFlight: () => maxInFlight };
}

const PHONE = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+\d{1,3}[\s.-]\d[\d\s.-]{6,}\d/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

describe("the walk", () => {
	it("never has two requests in flight and starts each at least 1000ms after the last", async () => {
		const s = setup();
		await s.run();
		expect(s.log.length).toBeGreaterThanOrEqual(20);
		expect(s.maxInFlight()).toBe(1);
		for (let i = 1; i < s.log.length; i++) {
			expect(s.log[i].startedAt - s.log[i - 1].startedAt).toBeGreaterThanOrEqual(MIN_GAP_MS);
		}
	});

	it("fetches what the issue lists, in order: club, members, meeting lists back to the first, meetings, speeches, charts, evaluations", async () => {
		const s = setup();
		await s.run();
		const path = (r: FakeRequest) => new URL(r.url).pathname + new URL(r.url).search;
		const paths = s.log.map(path);
		expect(paths.slice(0, 2)).toEqual(["/clubdata.php", "/memberlist.php"]);
		// Newest year first, then back until two empty years in a row after the first meeting.
		const years = s.log.filter((r) => r.method === "POST").map((r) => new URLSearchParams(r.body ?? "").get("start_year"));
		expect(years).toEqual(["2027", "2026", "2025", "2024"]);
		expect(s.log.filter((r) => r.method === "POST").every((r) => r.url.endsWith("/meeting_list.php"))).toBe(true);
		expect(paths).toEqual(
			expect.arrayContaining([
				"/view_meeting.php?t=644360",
				"/view_meeting.php?t=644304",
				"/view_meeting.php?t=644363",
				"/tm_all_speeches.php",
				"/request_speech.php?mode=entertitle&s=1473688&u=900001",
				"/request_speech.php?mode=entertitle&s=1473689&u=900001",
				"/memberchart.php?chart=1",
				"/memberchart.php?chart=4",
				"/memberchart.php?chart=7",
				"/memberchart.php?chart=8",
				"/my_evaluations.php",
				"/api/v1/evaluations.php/my-evaluations",
				"/api/v1/evaluations.php/eval/501",
				"/api/v1/evaluations.php/eval/502",
			]),
		);
		// A draft evaluation is not fetched.
		expect(paths).not.toContain("/api/v1/evaluations.php/eval/503");
		// Everything is one origin, with the page's cookies.
		expect(new Set(s.log.map((r) => new URL(r.url).origin))).toEqual(new Set(["https://easy-speak.org"]));
	});

	it("matches the meeting list's count and gives the viewer's own speech its id and introduction", async () => {
		const s = setup();
		const { bundle } = await s.run();
		expect(bundle.meetings).toHaveLength(3);
		const own = bundle.meetings.find((m) => m.esMeetingId === "644360")?.roles.find((r) => r.role === "1st Speaker");
		expect(own?.speech).toMatchObject({
			esSpeechId: "1473688",
			introduction: expect.stringContaining("grows tomatoes"),
		});
		// Everyone else's speech has no introduction: a member cannot see it.
		const others = bundle.meetings.flatMap((m) => m.roles).filter((r) => r.speech && r !== own);
		expect(others.every((r) => r.speech?.introduction === null)).toBe(true);
		expect(bundle.speechRequests.filter((r) => r.introduction !== null)).toHaveLength(1);
	});

	it("names the file easy-speak-<club number>-<date>.json", async () => {
		const { fileName } = await setup().run();
		expect(fileName).toBe("easy-speak-9999-2026-10-12.json");
	});

	it("tolerates a member's evaluations: best-effort, and [] is a valid bundle", async () => {
		const s = setup({ failOn: (u) => u.includes("/api/v1/evaluations.php/my-evaluations") });
		const { bundle } = await s.run();
		expect(bundle.evaluations).toEqual([]);
		expect(bundle.meetings).toHaveLength(3);
	});

	it("aborts on a failing page and names it", async () => {
		const s = setup({ failOn: (u) => u.endsWith("/tm_all_speeches.php") });
		await expect(s.run()).rejects.toThrow(/500.*speech list/);
	});

	it("aborts on a page that is not signed in, rather than storing it", async () => {
		const c = clock();
		const store = memoryStore();
		await expect(
			runExport({
				fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html><body><form>Username</form></body></html>" }),
				parseHtml,
				store,
				sleep: c.sleep,
				now: c.now,
			}),
		).rejects.toThrow(/not a signed-in Easy-Speak page/);
		expect([...store.data.keys()].some((k) => k.startsWith("page:"))).toBe(false);
	});
});

describe("resume", () => {
	it("a reload mid-walk continues without re-fetching finished pages", async () => {
		const store = memoryStore();
		// First run dies at the speech list.
		const first = setup({ store, failOn: (u) => u.endsWith("/tm_all_speeches.php") });
		await expect(first.run()).rejects.toThrow();
		const finished = first.log.filter((r) => !r.url.endsWith("/tm_all_speeches.php")).map((r) => `${r.method} ${r.url} ${r.body ?? ""}`);
		expect(finished.length).toBeGreaterThan(5);
		expect(await readSession(store, first.c.now())).toMatchObject({ pages: finished.length });

		// "Reload": a new run, the same store. Only the rest is requested.
		const second = setup({ store });
		await second.run();
		const refetched = second.log.map((r) => `${r.method} ${r.url} ${r.body ?? ""}`).filter((k) => finished.includes(k));
		expect(refetched).toEqual([]);
		expect(second.log.map((r) => new URL(r.url).pathname)).toContain("/tm_all_speeches.php");
		expect(second.log.map((r) => new URL(r.url).pathname)).toContain("/api/v1/evaluations.php/my-evaluations");
	});

	it("a resumed walk produces the same bundle as an uninterrupted one", async () => {
		const clean = (await setup().run()).bundle;
		const store = memoryStore();
		const first = setup({ store, failOn: (u) => u.includes("memberchart.php?chart=7") });
		await expect(first.run()).rejects.toThrow();
		const resumed = (await setup({ store }).run()).bundle;
		// exportedAt and fetchedAt come from the clock; everything else is the same.
		const strip = (b: EasySpeakBundleV1) => ({ ...b, exportedAt: "", raw: b.raw.map((r) => ({ ...r, fetchedAt: "" })) });
		expect(strip(resumed)).toEqual(strip(clean));
	});

	it("does not resume a session that is over twelve hours old", async () => {
		const store = memoryStore();
		await expect(setup({ store, failOn: (u) => u.endsWith("/tm_all_speeches.php") }).run()).rejects.toThrow();
		const c = clock(Date.UTC(2026, 9, 13, 12, 0, 1));
		expect(await readSession(store, c.now())).toBeNull();
	});

	it("empties the store when the export finishes", async () => {
		const s = setup();
		await s.run();
		expect(s.store.data.size).toBe(0);
	});
});

describe("contact details never leave the pages that carry them", () => {
	it("keeps memberlist.php and clubdata.php out of raw", async () => {
		const { bundle } = await setup().run();
		expect(bundle.raw.length).toBeGreaterThan(15);
		expect(bundle.raw.some((r) => isContactPage(r.url))).toBe(false);
		expect(bundle.raw.some((r) => /memberlist|clubdata/.test(r.url))).toBe(false);
	});

	it("has no phone number or email in any raw page", async () => {
		const { bundle } = await setup().run();
		for (const r of bundle.raw) {
			expect(r.html, r.url).not.toMatch(PHONE);
			expect(r.html, r.url).not.toMatch(EMAIL);
		}
	});

	it("proves the patterns would catch the contact pages", () => {
		expect(readFixture("member-list.html")).toMatch(PHONE);
		expect(readFixture("club-data.html")).toMatch(PHONE);
	});

	it("stores only the parsed result of a contact page, never its HTML, even for resume", async () => {
		const store = memoryStore();
		await expect(setup({ store, failOn: (u) => u.endsWith("/tm_all_speeches.php") }).run()).rejects.toThrow();
		for (const key of ["page:clubdata", "page:memberlist"]) {
			const entry = store.data.get(key) as { body?: string; parsed?: unknown };
			expect(entry.body).toBeUndefined();
			expect(entry.parsed).toBeDefined();
		}
		expect(JSON.stringify([...store.data.values()])).not.toMatch(PHONE);
	});

	it("gives the people and club sections no contact details", async () => {
		const { bundle } = await setup().run();
		expect(JSON.stringify([bundle.people, bundle.club])).not.toMatch(/555|@|\d{3}-\d{4}/);
	});
});

describe("bundle.expected.json", () => {
	it("is the bundle the walk produces from the fixtures (UPDATE_FIXTURES=1 rewrites it)", async () => {
		const { bundle } = await setup().run();
		const json = `${JSON.stringify(bundle, null, "\t")}\n`;
		const file = fixturePath("bundle.expected.json");
		if (process.env.UPDATE_FIXTURES === "1") writeFileSync(file, json);
		expect(readFileSync(file, "utf8")).toBe(json);
	});
});

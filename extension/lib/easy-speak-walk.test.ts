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
	EMAIL,
	FIXTURE_IDENTITY,
	type FakeRequest,
	PHONE,
	clock,
	fixturePath,
	memoryStore,
	parseHtml,
	readFixture,
	setup,
} from "./easy-speak-test-kit";
import {
	EARLIEST_MEETING_YEAR,
	MIN_GAP_MS,
	readSession,
	runExport,
} from "./easy-speak-walk";

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
		// Newest year first, then every year back to the floor.
		const years = s.log.filter((r) => r.method === "POST").map((r) => Number(new URLSearchParams(r.body ?? "").get("start_year")));
		expect(years[0]).toBe(2027);
		expect(years.at(-1)).toBe(EARLIEST_MEETING_YEAR);
		expect(years).toEqual(Array.from({ length: 2027 - EARLIEST_MEETING_YEAR + 1 }, (_, i) => 2027 - i));
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
				owner: "tab-a",
				identity: FIXTURE_IDENTITY,
				sleep: c.sleep,
				now: c.now,
			}),
		).rejects.toThrow(/not a signed-in Easy-Speak page/);
		expect([...store.data.keys()].some((k) => k.startsWith("page:"))).toBe(false);
	});
});

describe("speech request forms (the popup shows no viewer)", () => {
	const isRequest = (u: string) => u.includes("/request_speech.php");
	const requestKeys = (store: { data: Map<string, unknown> }) => [...store.data.keys()].filter((k) => k.includes("request:"));
	const loginPage = "<html><body><form>Username <input name=\"username\"> Password <input name=\"password\"></form></body></html>";

	it("completes with a request form that names no viewer, and reads the introduction from it", async () => {
		expect(readFixture("speech-request-intro.html")).not.toMatch(/Welcome|class="name"/);
		const s = setup();
		const { bundle } = await s.run();
		expect(JSON.stringify(bundle)).toContain("grows tomatoes");
	});

	it("fails with the sign-in message when a login page is served for a request form", async () => {
		const s = setup({ override: (u) => (isRequest(u) ? loginPage : undefined) });
		await expect(s.run()).rejects.toThrow(/speech request 1 of \d+ is not a signed-in Easy-Speak page\. Sign in/);
		expect(requestKeys(s.store)).toEqual([]);
	});

	it("ends the walk when the account changed by the closing check, and keeps none of the forms", async () => {
		let listAsked = 0;
		const s = setup({
			as: (_i, url) => {
				if (url.endsWith("/tm_all_speeches.php")) listAsked += 1;
				return listAsked >= 2 ? { ...FIXTURE_IDENTITY, username: "someoneelse" } : FIXTURE_IDENTITY;
			},
		});
		await expect(s.run()).rejects.toThrow(/signed in as another account/);
		expect(requestKeys(s.store)).toEqual([]);
	});

	it("runs the closing check once, after every form, and not from the store", async () => {
		const s = setup();
		await s.run();
		const urls = s.log.map((r) => new URL(r.url).pathname);
		const lastForm = urls.lastIndexOf("/request_speech.php");
		expect(urls.slice(lastForm + 1)[0]).toBe("/tm_all_speeches.php");
		expect(urls.filter((u) => u === "/tm_all_speeches.php")).toHaveLength(2);
	});

	it("ends the walk when a request form belongs to another club", async () => {
		const s = setup({
			override: (u) =>
				isRequest(u)
					? readFixture("speech-request-intro.html").replace('name="cached_club" value="4242"', 'name="cached_club" value="9090"')
					: undefined,
		});
		await expect(s.run()).rejects.toThrow(/another club/);
		expect(requestKeys(s.store)).toEqual([]);
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
		expect(bundle.raw.length).toBeGreaterThanOrEqual(15);
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

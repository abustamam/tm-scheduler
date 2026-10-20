/**
 * The Easy-Speak walk against the committed fixtures, served as a fake site
 * (`easy-speak-test-kit.ts`). Covers the acceptance criteria that are about
 * behaviour: one request at a time with a 1s gap, resume without re-fetching,
 * no contact pages in `raw`, and the expected bundle itself.
 * Run: cd extension && bunx vitest run lib/easy-speak-walk.test.ts
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	isContactPage,
} from "./easy-speak-bundle";
import {
	EMAIL,
	FIXTURE_IDENTITY,
	type FakeRequest,
	PHONE,
	clock,
	fixturePath,
	fixtureViolations,
	replay,
	memoryStore,
	parseHtml,
	readFixture,
	setup,
	stripClock,
} from "./easy-speak-test-kit";
import {
	EARLIEST_MEETING_YEAR,
	MIN_GAP_MS,
	RETRY_WAIT_MS,
	readSession,
	resumeState,
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
		const clean = await setup().run();
		const store = memoryStore();
		const first = setup({ store, failOn: (u) => u.includes("memberchart.php?chart=7") });
		await expect(first.run()).rejects.toThrow();
		const resumed = await setup({ store }).run();
		// exportedAt and fetchedAt come from the clock; everything else is the same.
		expect(stripClock(resumed)).toEqual(stripClock(clean));
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
	it("keeps memberlist.php and clubdata.php out of both files", async () => {
		const { bundle, archive } = await setup().run();
		expect(archive.pages.length).toBeGreaterThanOrEqual(15);
		expect(archive.pages.some((r) => isContactPage(r.url))).toBe(false);
		expect(archive.pages.some((r) => /memberlist|clubdata/.test(r.url))).toBe(false);
		expect(JSON.stringify(bundle)).not.toMatch(/memberlist\.php|clubdata\.php/);
	});

	it("has no phone number or email in any archived page", async () => {
		const { archive } = await setup().run();
		for (const r of archive.pages) {
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

/** The `raw` URLs bundle.expected.json held before #1235 moved them to the archive. */
const PRE_CHANGE_RAW_URLS = [
	"https://easy-speak.org/meeting_list.php#POST mode=roles&start_month=01&start_year=2026&end_month=12&end_year=2026",
	"https://easy-speak.org/view_meeting.php?t=644363",
	"https://easy-speak.org/view_meeting.php?t=644360",
	"https://easy-speak.org/view_meeting.php?t=644304",
	"https://easy-speak.org/tm_all_speeches.php",
	"https://easy-speak.org/request_speech.php?mode=entertitle&s=1473688&u=900001",
	"https://easy-speak.org/request_speech.php?mode=entertitle&s=1473689&u=900001",
	"https://easy-speak.org/memberchart.php?chart=1",
	"https://easy-speak.org/memberchart.php?chart=4",
	"https://easy-speak.org/memberchart.php?chart=7",
	"https://easy-speak.org/memberchart.php?chart=8",
	"https://easy-speak.org/my_evaluations.php",
	"https://easy-speak.org/api/v1/evaluations.php/my-evaluations",
	"https://easy-speak.org/api/v1/evaluations.php/eval/501",
	"https://easy-speak.org/api/v1/evaluations.php/eval/502",
];

describe("the archive file", () => {
	it("leaves raw empty in the upload bundle", async () => {
		const { bundle } = await setup().run();
		expect(bundle.raw).toEqual([]);
	});

	it("holds the pages raw held before, and names the two files as a pair", async () => {
		const { bundle, fileName, archive, archiveFileName } = await setup().run();
		expect(archive.format).toBe("gavelup.easy-speak-pages");
		expect(archive.version).toBe(1);
		expect(archive.exportedAt).toBe(bundle.exportedAt);
		expect(archive.club).toEqual({ esClubId: bundle.club.esClubId, number: bundle.club.number });
		expect(archiveFileName).toBe(fileName.replace(/\.json$/, "-pages.json"));
		expect(archive.pages.map((p) => p.url).sort()).toEqual([...PRE_CHANGE_RAW_URLS].sort());
		expect(archive.pages.some((p) => /view_meeting\.php/.test(p.url) && p.html.length > 0)).toBe(true);
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

// A 700-meeting walk meets a slow Easy-Speak: Cloudflare answers 524 when it takes over 100s.
describe("a slow Easy-Speak", () => {
	const MEETING = "view_meeting.php?t=644363";
	/** True for the first `n` requests that match, then false. */
	const firstTimes = (n: number, suffix: string) => {
		let hits = 0;
		return (u: string) => u.endsWith(suffix) && hits++ < n;
	};
	const asked = (log: FakeRequest[], suffix: string) => log.filter((r) => r.url.endsWith(suffix));

	it("asks a page that answered 524 once more, after a pause, and finishes", async () => {
		const s = setup({ failOn: firstTimes(1, MEETING), failStatus: 524 });
		const { bundle } = await s.run();
		expect(bundle.meetings).toHaveLength(3);
		const tries = asked(s.log, MEETING);
		expect(tries).toHaveLength(2);
		expect(tries[1].startedAt - tries[0].startedAt).toBeGreaterThanOrEqual(RETRY_WAIT_MS);
		expect(s.progress.some((l) => /returned 524 .* Trying again in 30s\./.test(l))).toBe(true);
	});

	it("asks again after a request that failed outright", async () => {
		const s = setup({ throwOn: firstTimes(1, MEETING) });
		const { bundle } = await s.run();
		expect(bundle.meetings).toHaveLength(3);
		expect(asked(s.log, MEETING)).toHaveLength(2);
	});

	it("stops for Resume after the second 5xx, saying it tried twice", async () => {
		const s = setup({ failOn: (u) => u.endsWith(MEETING), failStatus: 524 });
		await expect(s.run()).rejects.toThrow(/returned 524 for .*Tried twice, 30s apart\./);
		expect(asked(s.log, MEETING)).toHaveLength(2);
	});

	it("does not ask again after a 4xx: Easy-Speak answered, and the answer is no", async () => {
		const s = setup({ failOn: (u) => u.endsWith(MEETING), failStatus: 403 });
		await expect(s.run()).rejects.toThrow(/returned 403 for/);
		expect(asked(s.log, MEETING)).toHaveLength(1);
	});

	// The pause is longer than the lease. A lapsed lease reads as "auto" to another open tab,
	// which would start the walk itself, without the pause.
	it("keeps the lease through the pause: another open tab still sees the walk as elsewhere", async () => {
		const c = clock();
		const store = memoryStore();
		const seen: string[] = [];
		const watched = {
			...c,
			sleep: async (ms: number) => {
				await c.sleep(ms);
				seen.push((await resumeState(store, "tab-b", c.now(), FIXTURE_IDENTITY)).kind);
			},
		};
		const s = setup({ store, clock: watched, failOn: firstTimes(1, MEETING), failStatus: 524 });
		await s.run();
		expect(asked(s.log, MEETING)).toHaveLength(2);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.filter((k) => k !== "elsewhere")).toEqual([]);
	});

	it.each([302, 400, 429, 499, 600])("does not ask again after a %i", async (status) => {
		const s = setup({ failOn: (u) => u.endsWith(MEETING), failStatus: status });
		await expect(s.run()).rejects.toThrow(new RegExp(`returned ${status} for`));
		expect(asked(s.log, MEETING)).toHaveLength(1);
	});

	it.each([500, 503, 599])("asks again after a %i", async (status) => {
		const s = setup({ failOn: firstTimes(1, MEETING), failStatus: status });
		await s.run();
		expect(asked(s.log, MEETING)).toHaveLength(2);
	});

	it("does not ask again when another tab took the export over during the pause", async () => {
		const store = memoryStore();
		const c = clock();
		const failOn = (u: string) => {
			if (!u.endsWith(MEETING)) return false;
			// Another tab takes the lease while this one waits to ask again.
			store.data.set("lease", { owner: "tab-b", expiresAt: c.now() + RETRY_WAIT_MS * 10 });
			return true;
		};
		const s = setup({ store, clock: c, failOn, failStatus: 524 });
		await expect(s.run()).rejects.toThrow(/Another Easy-Speak tab took over/);
		expect(asked(s.log, MEETING)).toHaveLength(1);
	});
});

// ---------------------------------------------------------------- replay and fixture generation (#1252)

describe("replay: a live-site page served into the walk", () => {
	const intro = "speech-request-intro.html";
	const requests = (r: { log: FakeRequest[] }) => r.log.filter((q) => q.url.includes("/request_speech.php"));

	// #1234: Easy-Speak showed a speech request form with no viewer and the walk stopped at it.
	// speech-request-intro.html IS that page (anonymised), so the backfill needs no new fixture.
	it("#1234: a request form with no viewer finishes the walk, whichever speech asks for it", async () => {
		const r = replay({ "/request_speech.php": intro });
		const { bundle } = await r.run();
		expect(JSON.stringify(bundle)).toContain("grows tomatoes");
		expect(requests(r).length).toBeGreaterThan(1);
	});

	it("an empty replay is the usual site", async () => {
		const plain = stripClock(await setup().run()).bundle;
		expect(stripClock(await replay({}).run()).bundle).toEqual(plain);
	});

	it("a replayed page that is not a signed-in page still fails the walk, so the replay is not a pass-through", async () => {
		const r = replay({ "/request_speech.php": "club-data.html" });
		await expect(r.run()).rejects.toThrow(/speech request/);
	});

	it("a query-carrying key wins over a bare path for that request only", async () => {
		// The bare key serves a page that is no request form, so the walk stops at the first speech
		// the specific key does not answer; the specific key must have answered 1473688.
		const bare = replay({ "/request_speech.php": "club-data.html", "/request_speech.php?s=1473688": intro });
		await expect(bare.run()).rejects.toThrow(/speech request/);
		// It got past 1473688 (the specific key answered it) and stopped at another speech's form.
		const asked = requests(bare).map((q) => q.url);
		expect(asked.some((u) => u.includes("s=1473688"))).toBe(true);
		expect(asked.at(-1)).not.toContain("s=1473688");
	});
});

describe("the fixture guard as a function", () => {
	const htmlFixtures = readdirSync(fixturePath("")).filter((f) => f.endsWith(".html"));

	it("finds the committed pages (a floor: an empty list would pass every check below)", () => {
		expect(htmlFixtures.length).toBeGreaterThanOrEqual(10);
	});

	it.each(htmlFixtures)("%s has no violation (the committed pages and the guard agree)", (file) => {
		const contactPage = file === "club-data.html" || file === "member-list.html";
		expect(fixtureViolations(readFixture(file), { contactPage })).toEqual([]);
	});

	it("names a real-looking name, id, username, phone and email", () => {
		const bad = readFixture("member-list.html")
			.replace("Avery Alderfinch", "Jordan Testwright")
			.replace("u=900001", "u=123456")
			.replace("[fixtureuser]&nbsp;", "[jtest]&nbsp;")
			.replace("(555) 010-0001", "(212) 555-0142")
			.replace("</body>", "<p>jordan@example.com</p></body>");
		const v = fixtureViolations(bad).join("\n");
		expect(v).toMatch(/Jordan Testwright/);
		expect(v).toMatch(/123456/);
		expect(v).toMatch(/212\) 555-0142/);
		expect(v).toMatch(/email/);
	});
});

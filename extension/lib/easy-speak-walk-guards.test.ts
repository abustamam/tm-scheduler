/**
 * The walk's failure paths, its one-walker lease, its resume decision and its
 * walk back to the first meeting (#1047, review round). The happy path and the
 * politeness rules are in `easy-speak-walk.test.ts`.
 * Run: cd extension && bunx vitest run lib/easy-speak-walk-guards.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	FIXTURE_IDENTITY,
	clock,
	meetingListOf,
	memoryStore,
	readFixture,
	setup,
} from "./easy-speak-test-kit";
import {
	AUTO_RESUME_WINDOW_MS,
	EARLIEST_MEETING_YEAR,
	LEASE_RECHECK_SLACK_MS,
	LEASE_TTL_MS,
	SESSION_TTL_MS,
	type Identity,
	type ResumeState,
	acquireLease,
	followResume,
	releaseLease,
	resumeState,
} from "./easy-speak-walk";

const at = (path: string) => `https://easy-speak.org/${path}`;

describe("walking back to the first meeting", () => {
	it("reads meetings from before a gap of several empty years", async () => {
		// 2026, then nothing for 2022-2025, then a meeting in 2021: the old "two empty years" stop dropped it.
		const s = setup({
			listByYear: {
				"2026": readFixture("meeting-list.html"),
				"2021": meetingListOf(["644999"]),
			},
			extraMeetings: { "644999": "meeting-completed.html" },
		});
		const { bundle } = await s.run();
		expect(bundle.meetings.map((m) => m.esMeetingId).sort()).toEqual(["644304", "644360", "644363", "644999"]);
	});

	it("goes down to the floor year and no further", async () => {
		const s = setup({
			listByYear: {
				"2026": readFixture("meeting-list.html"),
				[String(EARLIEST_MEETING_YEAR)]: meetingListOf(["644998"]),
			},
			extraMeetings: { "644998": "meeting-completed.html" },
		});
		const { bundle } = await s.run();
		expect(bundle.meetings.map((m) => m.esMeetingId)).toContain("644998");
		const years = s.log
			.filter((r) => r.method === "POST")
			.map((r) => Number(new URLSearchParams(r.body ?? "").get("start_year")));
		expect(Math.min(...years)).toBe(EARLIEST_MEETING_YEAR);
	});

	it("keeps the lists of years with meetings in raw and leaves out the empty years", async () => {
		const { bundle } = await setup().run();
		const lists = bundle.raw.filter((r) => r.url.includes("meeting_list.php"));
		expect(lists.map((r) => r.url)).toEqual([expect.stringContaining("start_year=2026")]);
	});
});

describe("the walk's error paths name what went wrong and keep what was fetched", () => {
	it("aborts when the member list has more than one page", async () => {
		const s = setup({
			override: (url) =>
				url.endsWith("/memberlist.php")
					? readFixture("member-list.html").replace("Page <b>1</b> of <b>1</b>", "Page <b>1</b> of <b>3</b>")
					: undefined,
		});
		await expect(s.run()).rejects.toThrow(/member list has 3 pages/);
		// It stopped there: nothing after the member list was requested.
		expect(s.log.map((r) => new URL(r.url).pathname)).toEqual(["/clubdata.php", "/memberlist.php"]);
	});

	it("aborts when the meeting list shows no meetings in any year", async () => {
		const s = setup({ listByYear: {} });
		await expect(s.run()).rejects.toThrow(/meeting list showed no meetings/);
	});

	it("aborts when clubdata.php carries no club id", async () => {
		const s = setup({
			override: (url) =>
				url.endsWith("/clubdata.php")
					? readFixture("club-data.html")
							.replace(/view_meeting\.php\?c=\d+/g, "view_meeting.php?show=next")
							.replace(/<input[^>]*cached_club[^>]*>/g, "")
					: undefined,
		});
		await expect(s.run()).rejects.toThrow(/club id on clubdata\.php/);
	});

	it("aborts on a signed-in page that is not a meeting, naming the meeting", async () => {
		const s = setup({
			override: (url) => (url.endsWith("view_meeting.php?t=644304") ? readFixture("member-list.html") : undefined),
		});
		await expect(s.run()).rejects.toThrow(/Meeting 644304 is not a readable meeting page/);
	});

	it("aborts when a request itself fails, naming the page", async () => {
		const s = setup({ throwOn: (url) => url.endsWith("/tm_all_speeches.php") });
		await expect(s.run()).rejects.toThrow(/request failed \(speech list\): Failed to fetch/);
	});

	it("aborts on an error status for a meeting, naming it by position", async () => {
		const s = setup({ failOn: (url) => url.endsWith("view_meeting.php?t=644363") });
		await expect(s.run()).rejects.toThrow(/500 for meeting \d of 3/);
	});
});

describe("evaluations are best-effort, but only for request and sign-in failures (the parser's own cases: easy-speak-walk-evaluations.test.ts)", () => {
	it("gives [] when one evaluation's detail fails part-way through the list, not the ones before it", async () => {
		const s = setup({ failOn: (url) => url.endsWith("/eval/502") });
		const { bundle } = await s.run();
		expect(s.log.map((r) => new URL(r.url).pathname)).toContain("/api/v1/evaluations.php/eval/501");
		expect(bundle.evaluations).toEqual([]);
		expect(bundle.meetings).toHaveLength(3);
	});

	it("gives [] when the evaluations page is not signed in", async () => {
		const s = setup({
			override: (url) => (url.endsWith("/my_evaluations.php") ? "<html><body><form>Username</form></body></html>" : undefined),
		});
		const { bundle } = await s.run();
		expect(bundle.evaluations).toEqual([]);
	});

	it("gives [] when the evaluations API answers 200 with something that is not JSON", async () => {
		const s = setup({
			override: (url) => (url.endsWith("/my-evaluations") ? "<html><body>Please sign in</body></html>" : undefined),
		});
		const { bundle } = await s.run();
		expect(bundle.evaluations).toEqual([]);
	});
});

describe("one walker at a time", () => {
	it("refuses a second walker while the first holds the lease, and makes no request", async () => {
		const c = clock();
		const store = memoryStore();
		const a = setup({ store, clock: c, owner: "tab-a" });
		const b = setup({ store, clock: c, owner: "tab-b" });
		const first = a.run();
		await expect(b.run()).rejects.toThrow(/Another Easy-Speak tab is already running this export/);
		expect(b.log).toEqual([]);
		expect((await first).bundle.meetings).toHaveLength(3);
	});

	it("lets a second walker start once the first has finished", async () => {
		const c = clock();
		const store = memoryStore();
		await setup({ store, clock: c, owner: "tab-a" }).run();
		const b = await setup({ store, clock: c, owner: "tab-b" }).run();
		expect(b.bundle.meetings).toHaveLength(3);
	});

	it("gives the lease up when a walk aborts, so Resume works at once in any tab", async () => {
		const c = clock();
		const store = memoryStore();
		const a = setup({ store, clock: c, owner: "tab-a", failOn: (u) => u.endsWith("/tm_all_speeches.php") });
		await expect(a.run()).rejects.toThrow();
		const b = setup({ store, clock: c, owner: "tab-b" });
		const { bundle } = await b.run();
		expect(bundle.meetings).toHaveLength(3);
		// And it resumed: the pages tab-a finished were not requested again.
		expect(b.log.map((r) => new URL(r.url).pathname)).not.toContain("/clubdata.php");
	});

	it("takes over a lease that has expired (its tab is gone)", async () => {
		const c = clock();
		const store = memoryStore();
		await store.set("lease", { owner: "ghost", expiresAt: c.now() - 1 });
		const { bundle } = await setup({ store, clock: c, owner: "tab-a" }).run();
		expect(bundle.meetings).toHaveLength(3);
	});

	it("refuses a lease that has not expired", async () => {
		const c = clock();
		const store = memoryStore();
		await store.set("lease", { owner: "ghost", expiresAt: c.now() + 1000 });
		const s = setup({ store, clock: c, owner: "tab-a" });
		await expect(s.run()).rejects.toThrow(/Another Easy-Speak tab/);
		expect(s.log).toEqual([]);
	});

	it("renews the lease before every request, so a long walk never lets it lapse", async () => {
		const c = clock();
		const store = memoryStore();
		const seen: number[] = [];
		const s = setup({
			store,
			clock: c,
			override: () => {
				seen.push((store.data.get("lease") as { expiresAt: number }).expiresAt);
				return undefined;
			},
		});
		await s.run();
		expect(seen.length).toBeGreaterThanOrEqual(20);
		expect(seen[0]).toBeGreaterThan(c.now() - 1_000_000);
		// The first two requests share a millisecond (no gap before the first); after that each is a second on.
		for (let i = 2; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
		// The walk takes longer than one lease; it was held all the way through.
		expect(seen.at(-1)! - seen[0]).toBeGreaterThan(LEASE_TTL_MS / 4);
	});

	it("stops, and does not call the evaluations best-effort, when another tab took the lease mid-walk", async () => {
		const c = clock();
		const store = memoryStore();
		const s = setup({
			store,
			clock: c,
			override: (url) => {
				if (url.endsWith("/tm_all_speeches.php")) {
					store.data.set("lease", { owner: "tab-b", expiresAt: c.now() + LEASE_TTL_MS });
				}
				return undefined;
			},
		});
		await expect(s.run()).rejects.toThrow(/took over this export/);
		// The thief's lease is not released by the loser, and the page that was in flight is not stored.
		expect(store.data.get("lease")).toMatchObject({ owner: "tab-b" });
		expect(store.data.has("page:speeches")).toBe(false);
		expect(s.log.map((r) => new URL(r.url).pathname)).not.toContain("/api/v1/evaluations.php/my-evaluations");
	});

	it("acquireLease and releaseLease: only the owner releases", async () => {
		const store = memoryStore();
		expect(await acquireLease(store, "a", 1000)).toBe(true);
		expect(await acquireLease(store, "b", 1001)).toBe(false);
		expect(await acquireLease(store, "a", 1002)).toBe(true);
		await releaseLease(store, "b");
		expect(await acquireLease(store, "b", 1003)).toBe(false);
		await releaseLease(store, "a");
		expect(await acquireLease(store, "b", 1004)).toBe(true);
	});
});

describe("what a freshly loaded page does about an export in the store", () => {
	const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
	const session = (agoMs: number) => ({
		startedAt: NOW - agoMs,
		lastActivityAt: NOW - agoMs,
		pages: 7,
		identity: FIXTURE_IDENTITY,
	});
	const state = (store: ReturnType<typeof memoryStore>, owner = "me", identity = FIXTURE_IDENTITY) =>
		resumeState(store, owner, NOW, identity);

	it("names the window, two minutes", () => {
		expect(AUTO_RESUME_WINDOW_MS).toBe(2 * 60 * 1000);
	});

	it("has nothing to resume in an empty store", async () => {
		expect(await state(memoryStore())).toEqual({ kind: "none" });
	});

	it("starts on its own for a session from moments ago", async () => {
		const store = memoryStore();
		await store.set("meta", session(30_000));
		expect(await state(store)).toEqual({ kind: "auto", session: session(30_000) });
	});

	it("waits for the button once the window has passed, exactly at the window included", async () => {
		const store = memoryStore();
		await store.set("meta", session(AUTO_RESUME_WINDOW_MS - 1));
		expect((await state(store)).kind).toBe("auto");
		await store.set("meta", session(AUTO_RESUME_WINDOW_MS));
		expect((await state(store)).kind).toBe("manual");
		await store.set("meta", session(60 * 60 * 1000));
		expect((await state(store)).kind).toBe("manual");
	});

	it("forgets a session older than the twelve-hour limit", async () => {
		const store = memoryStore();
		await store.set("meta", session(SESSION_TTL_MS + 1));
		expect(await state(store)).toEqual({ kind: "none" });
	});

	it("does not start while another tab holds the lease, however fresh the session", async () => {
		const store = memoryStore();
		await store.set("meta", session(1000));
		await store.set("lease", { owner: "other", expiresAt: NOW + 5000 });
		expect((await state(store)).kind).toBe("elsewhere");
	});

	it("starts when the lease is its own or has expired", async () => {
		const store = memoryStore();
		await store.set("meta", session(1000));
		await store.set("lease", { owner: "me", expiresAt: NOW + 5000 });
		expect((await state(store)).kind).toBe("auto");
		await store.set("lease", { owner: "other", expiresAt: NOW - 1 });
		expect((await state(store)).kind).toBe("auto");
	});
});

describe("a stored export belongs to the club and account that started it", () => {
	const otherClub: Identity = { ...FIXTURE_IDENTITY, esClubId: `${FIXTURE_IDENTITY.esClubId}0` };
	const otherAccount: Identity = { ...FIXTURE_IDENTITY, username: `${FIXTURE_IDENTITY.username}-two` };
	const MARK = "FIRST-IDENTITY-PAGE-MARKER";
	const marked = (url: string) =>
		url.endsWith("view_meeting.php?t=644304") ? `${readFixture("meeting-completed.html")}<!--${MARK}-->` : undefined;
	const speechesDown = (u: string) => u.endsWith("/tm_all_speeches.php");

	for (const [what, other] of [
		["switches club", otherClub],
		["signs in as someone else", otherAccount],
	] as const) {
		it(`discards the cached export when the user ${what} before resuming, so no page of the first is in the bundle`, async () => {
			const store = memoryStore();
			const first = setup({ store, override: marked, failOn: speechesDown });
			await expect(first.run()).rejects.toThrow();
			expect(JSON.stringify([...store.data.values()])).toContain(MARK);

			const second = setup({ store, clock: first.c, identity: other });
			const { bundle } = await second.run();
			expect(JSON.stringify(bundle)).not.toContain(MARK);
			// Everything was asked for again, the club page and the meeting included.
			const paths = second.log.map((r) => r.url);
			expect(paths).toContain(at("clubdata.php"));
			expect(paths).toContain(at("view_meeting.php?t=644304"));
			expect(second.progress.some((l) => /Discarding an unfinished export/.test(l))).toBe(true);
		});
	}

	it("records the identity in the stored session, and an old session without one is not resumed", async () => {
		const store = memoryStore();
		await expect(setup({ store, failOn: speechesDown }).run()).rejects.toThrow();
		expect(store.data.get("meta")).toMatchObject({ identity: FIXTURE_IDENTITY });
		const meta = store.data.get("meta") as Record<string, unknown>;
		const { identity: _i, ...legacy } = meta;
		store.data.set("meta", legacy);
		const next = setup({ store });
		await next.run();
		expect(next.log.map((r) => r.url)).toContain(at("clubdata.php"));
	});

	it("resumes the same club and account with no re-fetch of what was finished, and no discard note", async () => {
		const store = memoryStore();
		const first = setup({ store, failOn: speechesDown });
		await expect(first.run()).rejects.toThrow();
		const second = setup({ store, clock: first.c });
		await second.run();
		expect(second.log.map((r) => new URL(r.url).pathname)).not.toContain("/clubdata.php");
		expect(second.log.map((r) => new URL(r.url).pathname)).not.toContain("/memberlist.php");
		expect(second.progress.some((l) => /Discarding/.test(l))).toBe(false);
	});

	describe("resumeState", () => {
		const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
		const stored = { startedAt: NOW - 1000, lastActivityAt: NOW - 1000, pages: 7, identity: FIXTURE_IDENTITY };

		it("reports auto for its own club and account, and none for another club or account", async () => {
			const store = memoryStore();
			await store.set("meta", stored);
			expect((await resumeState(store, "me", NOW, FIXTURE_IDENTITY)).kind).toBe("auto");
			expect(await resumeState(store, "me", NOW, otherClub)).toEqual({ kind: "none" });
			expect(await resumeState(store, "me", NOW, otherAccount)).toEqual({ kind: "none" });
		});

		it("does not offer Resume for another identity's session even when it is old", async () => {
			const store = memoryStore();
			await store.set("meta", { ...stored, lastActivityAt: NOW - AUTO_RESUME_WINDOW_MS - 1 });
			expect((await resumeState(store, "me", NOW, FIXTURE_IDENTITY)).kind).toBe("manual");
			expect(await resumeState(store, "me", NOW, otherClub)).toEqual({ kind: "none" });
		});

		it("does not show another identity's session while a lease is held", async () => {
			const store = memoryStore();
			await store.set("meta", stored);
			await store.set("lease", { owner: "other", expiresAt: NOW + 5000 });
			expect(await resumeState(store, "me", NOW, otherClub)).toMatchObject({ kind: "elsewhere", session: null });
		});
	});

});

describe("an unreadable page is rejected before it is cached", () => {
	it("re-fetches a meeting that was unreadable the first time, once the site is fine", async () => {
		const store = memoryStore();
		const first = setup({
			store,
			override: (u) => (u.endsWith("view_meeting.php?t=644304") ? readFixture("member-list.html") : undefined),
		});
		await expect(first.run()).rejects.toThrow(/Meeting 644304 is not a readable meeting page/);
		expect([...store.data.keys()]).not.toContain("page:meeting:644304");

		const second = setup({ store, clock: first.c });
		const { bundle } = await second.run();
		expect(second.log.map((r) => r.url)).toContain(at("view_meeting.php?t=644304"));
		expect(bundle.meetings).toHaveLength(3);
	});

	it("re-fetches a member list that had a second page the first time", async () => {
		const store = memoryStore();
		const first = setup({
			store,
			override: (u) =>
				u.endsWith("/memberlist.php")
					? readFixture("member-list.html").replace("Page <b>1</b> of <b>1</b>", "Page <b>1</b> of <b>3</b>")
					: undefined,
		});
		await expect(first.run()).rejects.toThrow(/member list has 3 pages/);
		expect([...store.data.keys()]).not.toContain("page:memberlist");

		const second = setup({ store, clock: first.c });
		const { bundle } = await second.run();
		expect(second.log.map((r) => r.url)).toContain(at("memberlist.php"));
		expect(bundle.meetings).toHaveLength(3);
	});
});

describe("a reload mid-walk picks the export up once the previous load's lease runs out", () => {
	/** Timers that run when the test says so, on the clock the walkers share. */
	function fakeTimers(c: ReturnType<typeof clock>) {
		const queue: { fn: () => unknown; ms: number; cleared: boolean }[] = [];
		return {
			now: c.now,
			setTimer: (fn: () => unknown, ms: number) => {
				const h = { fn, ms, cleared: false };
				queue.push(h);
				return h;
			},
			clearTimer: (h: unknown) => {
				(h as { cleared: boolean }).cleared = true;
			},
			/** Move the clock `ms`, then run the oldest timer that is still pending. */
			async fire(ms: number) {
				c.advance(ms);
				const next = queue.find((q) => !q.cleared);
				if (!next) throw new Error("no timer is pending");
				next.cleared = true;
				await next.fn();
			},
			pending: () => queue.filter((q) => !q.cleared).length,
			last: () => queue.at(-1),
		};
	}

	/** An export that died mid-walk in the previous page load, whose lease is still live. */
	async function crashedPreviousLoad() {
		const store = memoryStore();
		const old = setup({ store, owner: "old-load", failOn: (u) => u.endsWith("/tm_all_speeches.php") });
		await expect(old.run()).rejects.toThrow();
		const c = old.c;
		await store.set("lease", { owner: "old-load", expiresAt: c.now() + LEASE_TTL_MS });
		return { store, c };
	}

	it("a fresh owner sees the old lease as another tab's, waits out its expiry, then goes auto and resumes with no re-fetch", async () => {
		const { store, c } = await crashedPreviousLoad();
		const initial = await resumeState(store, "new-load", c.now(), FIXTURE_IDENTITY);
		expect(initial.kind).toBe("elsewhere");

		const timers = fakeTimers(c);
		const states: ResumeState[] = [];
		followResume(initial, { store, owner: "new-load", identity: FIXTURE_IDENTITY, ...timers, onState: (s) => states.push(s) });
		expect(timers.last()?.ms).toBe(LEASE_TTL_MS + LEASE_RECHECK_SLACK_MS);

		await timers.fire(LEASE_TTL_MS + LEASE_RECHECK_SLACK_MS);
		expect(states.map((s) => s.kind)).toEqual(["auto"]);
		expect(timers.pending()).toBe(0);

		const reload = setup({ store, clock: c, owner: "new-load" });
		await reload.run();
		expect(reload.log.map((r) => new URL(r.url).pathname)).not.toContain("/clubdata.php");
		expect(reload.log.map((r) => new URL(r.url).pathname)).toContain("/tm_all_speeches.php");
	});

	it("a live other tab that keeps renewing keeps this one waiting: it re-arms and never goes auto while the lease is renewed", async () => {
		const { store, c } = await crashedPreviousLoad();
		const initial = await resumeState(store, "new-load", c.now(), FIXTURE_IDENTITY);
		const timers = fakeTimers(c);
		const states: ResumeState[] = [];
		followResume(initial, { store, owner: "new-load", identity: FIXTURE_IDENTITY, ...timers, onState: (s) => states.push(s) });
		const renew = () => store.set("lease", { owner: "other-tab", expiresAt: c.now() + LEASE_TTL_MS });

		// The other tab renews a second before the first look: the old expiry is no longer the lease.
		c.advance(LEASE_TTL_MS - 1000);
		await renew();
		await timers.fire(1000 + LEASE_RECHECK_SLACK_MS);
		expect(states.map((s) => s.kind)).toEqual(["elsewhere"]);
		// Re-armed for the renewed lease, not the one it first saw.
		expect(timers.pending()).toBe(1);
		expect(timers.last()?.ms).toBe(LEASE_TTL_MS - 1000);

		await renew();
		await timers.fire(LEASE_TTL_MS - 1000);
		expect(states.map((s) => s.kind)).toEqual(["elsewhere", "elsewhere"]);
		expect(timers.pending()).toBe(1);

		// The other tab goes away without renewing: the look after its expiry is auto.
		await timers.fire(LEASE_TTL_MS + LEASE_RECHECK_SLACK_MS);
		expect(states.map((s) => s.kind)).toEqual(["elsewhere", "elsewhere", "auto"]);
		expect(timers.pending()).toBe(0);
	});

	it("cancel stops the re-check", async () => {
		const { store, c } = await crashedPreviousLoad();
		const initial = await resumeState(store, "new-load", c.now(), FIXTURE_IDENTITY);
		const timers = fakeTimers(c);
		const states: ResumeState[] = [];
		const f = followResume(initial, { store, owner: "new-load", identity: FIXTURE_IDENTITY, ...timers, onState: (s) => states.push(s) });
		f.cancel();
		expect(timers.pending()).toBe(0);
		expect(states).toEqual([]);
	});

	it("a lease released as the old page went away lets the next load start at once, with nothing to wait for", async () => {
		const { store, c } = await crashedPreviousLoad();
		await releaseLease(store, "old-load");
		expect((await resumeState(store, "new-load", c.now(), FIXTURE_IDENTITY)).kind).toBe("auto");
	});

	it("the lease lapses in twenty seconds, not a minute", () => {
		expect(LEASE_TTL_MS).toBe(20_000);
	});
});

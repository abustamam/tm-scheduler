/**
 * The walk's failure paths, its one-walker lease, its resume decision and its
 * walk back to the first meeting (#1047, review round). The happy path and the
 * politeness rules are in `easy-speak-walk.test.ts`.
 * Run: cd extension && bunx vitest run lib/easy-speak-walk-guards.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	clock,
	meetingListOf,
	memoryStore,
	readFixture,
	setup,
} from "./easy-speak-test-kit";
import {
	AUTO_RESUME_WINDOW_MS,
	EARLIEST_MEETING_YEAR,
	LEASE_TTL_MS,
	SESSION_TTL_MS,
	acquireLease,
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

describe("evaluations are best-effort, but only for request and sign-in failures", () => {
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

	it("lets a bug in the evaluation parser surface instead of exporting an empty list", async () => {
		// A `null` response row is a TypeError inside parseEvaluation, not a failed request.
		const s = setup({
			override: (url) => (url.endsWith("/eval/501") ? JSON.stringify({ evaluation: { responses: [null] } }) : undefined),
		});
		await expect(s.run()).rejects.toThrow(TypeError);
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
		// The thief's lease is not released by the loser.
		expect(store.data.get("lease")).toMatchObject({ owner: "tab-b" });
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
	const session = (agoMs: number) => ({ startedAt: NOW - agoMs, lastActivityAt: NOW - agoMs, pages: 7 });

	it("names the window, two minutes", () => {
		expect(AUTO_RESUME_WINDOW_MS).toBe(2 * 60 * 1000);
	});

	it("has nothing to resume in an empty store", async () => {
		expect(await resumeState(memoryStore(), "me", NOW)).toEqual({ kind: "none" });
	});

	it("starts on its own for a session from moments ago", async () => {
		const store = memoryStore();
		await store.set("meta", session(30_000));
		expect(await resumeState(store, "me", NOW)).toEqual({ kind: "auto", session: session(30_000) });
	});

	it("waits for the button once the window has passed, exactly at the window included", async () => {
		const store = memoryStore();
		await store.set("meta", session(AUTO_RESUME_WINDOW_MS - 1));
		expect((await resumeState(store, "me", NOW)).kind).toBe("auto");
		await store.set("meta", session(AUTO_RESUME_WINDOW_MS));
		expect((await resumeState(store, "me", NOW)).kind).toBe("manual");
		await store.set("meta", session(60 * 60 * 1000));
		expect((await resumeState(store, "me", NOW)).kind).toBe("manual");
	});

	it("forgets a session older than the twelve-hour limit", async () => {
		const store = memoryStore();
		await store.set("meta", session(SESSION_TTL_MS + 1));
		expect(await resumeState(store, "me", NOW)).toEqual({ kind: "none" });
	});

	it("does not start while another tab holds the lease, however fresh the session", async () => {
		const store = memoryStore();
		await store.set("meta", session(1000));
		await store.set("lease", { owner: "other", expiresAt: NOW + 5000 });
		expect((await resumeState(store, "me", NOW)).kind).toBe("elsewhere");
	});

	it("starts when the lease is its own or has expired", async () => {
		const store = memoryStore();
		await store.set("meta", session(1000));
		await store.set("lease", { owner: "me", expiresAt: NOW + 5000 });
		expect((await resumeState(store, "me", NOW)).kind).toBe("auto");
		await store.set("lease", { owner: "other", expiresAt: NOW - 1 });
		expect((await resumeState(store, "me", NOW)).kind).toBe("auto");
	});
});

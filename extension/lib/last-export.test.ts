/**
 * The remembered month and the widget's decisions (#1491). The widget's DOM wiring is not
 * covered here; its decisions are pure functions, tested below.
 * Run: cd extension && bunx vitest run lib/last-export.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	CLUB_CHANGED_MESSAGE,
	SAVE_FAILED_MESSAGE,
	type ExportFiles,
	type KvStore,
	clubChanged,
	finishExport,
	monthLabel,
	newestHeldMonth,
	prefill,
	readLastExport,
	saveLastExport,
	startMonth,
} from "./last-export";

const kv = (): KvStore & { data: Map<string, unknown> } => {
	const data = new Map<string, unknown>();
	return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
};
const NOW = () => Date.UTC(2026, 9, 12);
const meeting = (startsAt: string) => ({ startsAt }) as never;
const bundleOf = (exportedAt: string, timezone: string | null, starts: string[]) => ({
	exportedAt,
	club: { timezone },
	meetings: starts.map(meeting),
});

describe("monthLabel", () => {
	it("names the month in English", () => {
		// protects=the month shown in the status line; fails_when=an off-by-one month or a locale-dependent name; no_claim=none beyond protects
		expect(monthLabel("2026-05")).toBe("May 2026");
		expect(monthLabel("2004-01")).toBe("January 2004");
		expect(monthLabel("2026-12")).toBe("December 2026");
		expect(monthLabel("2026-13")).toBe("2026-13");
		expect(monthLabel("")).toBe("");
	});
});

describe("newestHeldMonth (AC 6)", () => {
	// protects=the remembered month being the newest meeting actually held; fails_when=a meeting after exportedAt, a wrong zone, or an offset-less time counted too early is picked; no_claim=real Easy-Speak dates (hand-written timestamps)
	it("ignores meetings after exportedAt", () => {
		const b = bundleOf("2026-10-12T12:00:00.000Z", "America/Los_Angeles", [
			"2026-09-23T02:00:00.000Z",
			"2026-10-14T02:00:00.000Z",
			"2027-01-06T02:00:00.000Z",
		]);
		expect(newestHeldMonth(b)).toBe("2026-09");
	});

	it("reads a Z timestamp in the club's zone", () => {
		const b = bundleOf("2026-10-12T12:00:00.000Z", "America/Los_Angeles", ["2026-06-01T02:00:00Z"]);
		expect(newestHeldMonth(b)).toBe("2026-05");
		expect(newestHeldMonth(bundleOf("2026-10-12T12:00:00.000Z", null, ["2026-06-01T02:00:00Z"]))).toBe("2026-06");
	});

	it("counts an offset-less time only when it is 14h or more before exportedAt", () => {
		const at = "2026-10-12T12:00:00.000Z";
		// 13h59m before: may not have started in the zone farthest ahead of UTC.
		expect(newestHeldMonth(bundleOf(at, null, ["2026-10-11T22:01:00"]))).toBeNull();
		// Exactly 14h before: counts, and its month is its own first 7 characters.
		expect(newestHeldMonth(bundleOf(at, null, ["2026-10-11T22:00:00"]))).toBe("2026-10");
		// An earlier month wins over a later one that does not count yet.
		expect(newestHeldMonth(bundleOf("2026-11-01T05:00:00.000Z", null, ["2026-10-31T20:00:00", "2026-10-15T19:00:00"]))).toBe("2026-10");
	});

	it("is null when no meeting had started", () => {
		expect(newestHeldMonth(bundleOf("2026-10-12T12:00:00.000Z", "America/Los_Angeles", ["2026-10-14T02:00:00.000Z"]))).toBeNull();
		expect(newestHeldMonth(bundleOf("2026-10-12T12:00:00.000Z", null, []))).toBeNull();
	});
});

describe("the remembered month (AC 7)", () => {
	// protects=a club's month pre-filling only that club, and a bad stored value never reaching the walk; fails_when=a key is shared between clubs or a malformed or out-of-range value is returned; no_claim=real IndexedDB (a map stands in)
	it("is keyed by Easy-Speak club", async () => {
		const store = kv();
		await saveLastExport("111", "2026-05", { kv: store, now: NOW });
		expect(await readLastExport("111", { kv: store, now: NOW })).toBe("2026-05");
		expect(await readLastExport("222", { kv: store, now: NOW })).toBeNull();
		expect(store.data.get("club:111")).toEqual({ month: "2026-05", savedAt: "2026-10-12T00:00:00.000Z" });
	});

	it.each([
		["a malformed month", { month: "2026-5", savedAt: "x" }],
		["a month past next year", { month: "2028-01", savedAt: "x" }],
		["a month before 2004", { month: "2003-12", savedAt: "x" }],
		["a value with no month", { savedAt: "x" }],
		["a string", "2026-05"],
	])("reads %s as nothing", async (_n, value) => {
		const store = kv();
		store.data.set("club:111", value);
		expect(await readLastExport("111", { kv: store, now: NOW })).toBeNull();
	});

	it("reads nothing when the read fails", async () => {
		const broken: KvStore = { get: async () => Promise.reject(new Error("denied")), set: async () => {} };
		expect(await readLastExport("111", { kv: broken, now: NOW })).toBeNull();
	});
});

describe("the widget's decisions (AC 8)", () => {
	// protects=the selects' pre-fill, the lock on Resume and the wrong-club refusal; fails_when=a remembered month fills for an unknown club, a session's month is ignored, or a different club starts; no_claim=the DOM wiring (checked by hand in the PR)
	it("pre-fills from the remembered month and is blank without one or without a known club", () => {
		expect(prefill({ esClubId: "111" }, "2026-05")).toEqual({ year: "2026", month: "05" });
		expect(prefill({ esClubId: "111" }, null).year).toBe("");
		expect(prefill(null, "2026-05").year).toBe("");
	});

	it("starts from the session's own month while one is stored, else from the selects", () => {
		expect(startMonth({ fromMonth: "2026-03" }, { year: "2026", month: "05" })).toBe("2026-03");
		expect(startMonth({}, { year: "2026", month: "05" })).toBeNull();
		expect(startMonth(null, { year: "2026", month: "05" })).toBe("2026-05");
		expect(startMonth(null, { year: "", month: "05" })).toBeNull();
	});

	it("refuses a start only when the load club is known and differs", () => {
		expect(clubChanged({ esClubId: "111" }, { esClubId: "222" })).toBe(true);
		expect(clubChanged({ esClubId: "111" }, { esClubId: "111" })).toBe(false);
		expect(clubChanged(null, { esClubId: "222" })).toBe(false);
		expect(CLUB_CHANGED_MESSAGE).toMatch(/Reload the page\.$/);
	});
});

describe("finishExport (AC 7)", () => {
	// protects=the month being remembered only after both files were handed over; fails_when=a month is saved after a failed download, or a failed save loses the status; no_claim=that the browser really wrote the files
	const files = (): ExportFiles => ({
		bundle: {
			exportedAt: "2026-10-12T12:00:00.000Z",
			club: { esClubId: "111", timezone: "America/Los_Angeles" },
			meetings: [{ startsAt: "2026-09-23T02:00:00.000Z" }],
		} as never,
		fileName: "easy-speak-1-2026-10-12.json",
		archive: { pages: [] },
		archiveFileName: "easy-speak-1-2026-10-12-pages.json",
	});

	it("downloads the bundle, then the archive, then saves the newest held month", async () => {
		const calls: string[] = [];
		const lines = await finishExport(files(), {
			download: (name) => void calls.push(`download ${name}`),
			save: async (club, month) => void calls.push(`save ${club} ${month}`),
		});
		expect(calls).toEqual(["download easy-speak-1-2026-10-12.json", "download easy-speak-1-2026-10-12-pages.json", "save 111 2026-09"]);
		expect(lines).toEqual(["Next time, export from September 2026."]);
	});

	it("saves nothing when the second download throws", async () => {
		const saved: string[] = [];
		let n = 0;
		await expect(
			finishExport(files(), {
				download: () => {
					if (++n === 2) throw new Error("blocked");
				},
				save: async (_c, m) => void saved.push(m),
			}),
		).rejects.toThrow("blocked");
		expect(saved).toEqual([]);
	});

	it("reports a failed save in the status and does not throw", async () => {
		const lines = await finishExport(files(), {
			download: () => {},
			save: async () => Promise.reject(new Error("quota")),
		});
		expect(lines).toContain(SAVE_FAILED_MESSAGE);
	});

	it("saves nothing and adds nothing when no meeting had started", async () => {
		const f = files();
		(f.bundle as unknown as { meetings: unknown[] }).meetings = [];
		const saved: string[] = [];
		const lines = await finishExport(f, { download: () => {}, save: async (_c, m) => void saved.push(m) });
		expect(saved).toEqual([]);
		expect(lines).toEqual([]);
	});
});

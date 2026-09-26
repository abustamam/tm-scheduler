import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAV_DESTINATIONS } from "./nav-destinations";
import {
	addToStoredSet,
	bannerEntry,
	eligibleEntries,
	FEATURE_KEYS,
	hasUnseenEntries,
	isFeatureNew,
	loadWhatsNewEntries,
	NEW_WINDOW_DAYS,
	parseWhatsNewEntry,
	publicEntries,
	readStoredSet,
	WHATS_NEW_ENTRIES,
	WHATS_NEW_LOAD_ERRORS,
	type WhatsNewEntry,
} from "./whats-new";

/**
 * "What's new" entries (#947). The first block is the guard: every shipped
 * entry under `content/whats-new/` parses, and the parser refuses each bad
 * shape a feature PR could plausibly write. The rest pins who sees what.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTENT_DIR = resolve(ROOT, "content/whats-new");

const GOOD = `---
title: Promote your next meeting
date: 2026-09-26
audience: admins
public: false
featureKey: account
link: /account
---
Draft a promo. You send it.
`;

function withLine(source: string, key: string, line: string | null): string {
	const lines = source.split("\n");
	const i = lines.findIndex((l) => l.startsWith(`${key}:`));
	if (line === null) lines.splice(i, 1);
	else lines[i] = line;
	return lines.join("\n");
}

function errorsOf(id: string, source: string): string[] {
	const r = parseWhatsNewEntry(id, source);
	return r.ok ? [] : r.errors;
}

const ID = "2026-09-26-promote";

function listSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		const full = resolve(dir, d.name);
		if (d.isDirectory()) return listSources(full);
		return /\.tsx?$/.test(d.name) ? [full] : [];
	});
}

describe("shipped entries (content/whats-new)", () => {
	const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"));

	it("ships at least one entry, so the feature is not empty on day one", () => {
		expect(files.length).toBeGreaterThan(0);
		// The glob and the directory agree: an entry the bundler did not pick up
		// would be a file nobody ever sees.
		expect(WHATS_NEW_ENTRIES.length).toBe(files.length);
	});

	it("every file parses, with no errors", () => {
		expect(WHATS_NEW_LOAD_ERRORS).toEqual([]);
		for (const f of files) {
			const source = readFileSync(resolve(CONTENT_DIR, f), "utf8");
			expect(errorsOf(f.replace(/\.md$/, ""), source)).toEqual([]);
		}
	});

	it("every featureKey in use is a known key", () => {
		for (const e of WHATS_NEW_ENTRIES) {
			if (e.featureKey) expect(FEATURE_KEYS).toContain(e.featureKey);
		}
	});

	it("every FEATURE_KEYS key has something that renders its badge", () => {
		// A nav destination is badged by the sidebar; anything else needs a
		// `useIsNew("<key>"` call in source. A key with neither is a badge
		// that can never show (the promote entry shipped that way once).
		const navKeys = new Set(NAV_DESTINATIONS.map((d) => d.key as string));
		const sources = listSources(resolve(ROOT, "src"))
			.filter((f) => !/\.test\.tsx?$/.test(f))
			.map((f) => readFileSync(f, "utf8"))
			.join("\n");
		for (const key of FEATURE_KEYS) {
			const called = sources.includes(`useIsNew("${key}"`);
			expect(
				navKeys.has(key) || called,
				`FEATURE_KEYS has "${key}" but nothing renders its badge`,
			).toBe(true);
		}
	});

	it("no admin-only entry is public", () => {
		for (const e of WHATS_NEW_ENTRIES) {
			if (e.audience === "admins") expect(e.public).toBe(false);
		}
	});
});

describe("parseWhatsNewEntry rejects a bad shape", () => {
	it("accepts the good fixture (control)", () => {
		const r = parseWhatsNewEntry(ID, GOOD);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.entry).toMatchObject({
				id: ID,
				title: "Promote your next meeting",
				date: "2026-09-26",
				audience: "admins",
				public: false,
				featureKey: "account",
				link: "/account",
				body: "Draft a promo. You send it.",
			});
		}
	});

	it.each([
		[
			"an unknown featureKey",
			withLine(GOOD, "featureKey", "featureKey: promo"),
		],
		["a missing title", withLine(GOOD, "title", null)],
		["a missing date", withLine(GOOD, "date", null)],
		["an impossible date", withLine(GOOD, "date", "date: 2026-02-30")],
		[
			"a date that disagrees with the filename",
			withLine(GOOD, "date", "date: 2026-09-25"),
		],
		["an unknown audience", withLine(GOOD, "audience", "audience: officers")],
		["a non-boolean public", withLine(GOOD, "public", "public: yes")],
		["a missing public", withLine(GOOD, "public", null)],
		["an admins entry marked public", withLine(GOOD, "public", "public: true")],
		["an off-site link", withLine(GOOD, "link", "link: https://example.com")],
		["a protocol-relative link", withLine(GOOD, "link", "link: //evil.test")],
		["a `when` (not supported)", withLine(GOOD, "link", "when: chartering")],
		["an unknown key", withLine(GOOD, "link", "feature: promote")],
		["an empty body", GOOD.replace("Draft a promo. You send it.\n", "")],
		["no front-matter", "Just a body.\n"],
	])("rejects %s", (_label, source) => {
		expect(errorsOf(ID, source).length).toBeGreaterThan(0);
	});

	it("rejects a filename that is not YYYY-MM-DD-<slug>", () => {
		expect(errorsOf("promote", GOOD).length).toBeGreaterThan(0);
		expect(errorsOf("2026-09-26_Promote", GOOD).length).toBeGreaterThan(0);
	});

	it("reports every problem, not only the first", () => {
		const bad = withLine(
			withLine(GOOD, "featureKey", "featureKey: nope"),
			"audience",
			"audience: nobody",
		);
		expect(errorsOf(ID, bad).length).toBeGreaterThanOrEqual(2);
	});

	it("loadWhatsNewEntries leaves a bad file out and reports it", () => {
		const { entries, errors } = loadWhatsNewEntries({
			[`/content/whats-new/${ID}.md`]: GOOD,
			"/content/whats-new/2026-09-27-bad.md": "no front-matter",
		});
		expect(entries.map((e) => e.id)).toEqual([ID]);
		expect(errors.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------

function entry(over: Partial<WhatsNewEntry> & { id: string }): WhatsNewEntry {
	return {
		title: over.id,
		date: "2026-09-20",
		audience: "everyone",
		public: true,
		body: "b",
		...over,
	};
}

const NOW = new Date("2026-09-25T12:00:00Z");
const ADMIN = entry({ id: "admin", audience: "admins", public: false });
const MEMBERS = entry({ id: "members", audience: "members" });
const EVERYONE = entry({ id: "everyone", audience: "everyone" });
const FUTURE = entry({ id: "future", date: "2026-09-26" });
const ALL = [ADMIN, MEMBERS, EVERYONE, FUTURE];

describe("eligibleEntries (panel audience)", () => {
	it("an admin sees admins + everyone, never members-only", () => {
		const ids = eligibleEntries(ALL, { isAdmin: true, now: NOW }).map(
			(e) => e.id,
		);
		expect(ids.sort()).toEqual(["admin", "everyone"]);
	});

	it("a member sees members + everyone, never admins-only", () => {
		const ids = eligibleEntries(ALL, { isAdmin: false, now: NOW }).map(
			(e) => e.id,
		);
		expect(ids.sort()).toEqual(["everyone", "members"]);
	});

	it("an entry dated after now is nobody's yet, then appears on its date", () => {
		for (const isAdmin of [true, false]) {
			expect(
				eligibleEntries(ALL, { isAdmin, now: NOW }).map((e) => e.id),
			).not.toContain("future");
			expect(
				eligibleEntries(ALL, {
					isAdmin,
					now: new Date("2026-09-26T00:00:00Z"),
				}).map((e) => e.id),
			).toContain("future");
		}
	});

	it("is newest first", () => {
		const older = entry({ id: "older", date: "2026-01-01" });
		const newer = entry({ id: "newer", date: "2026-09-01" });
		expect(
			eligibleEntries([older, newer], { isAdmin: false, now: NOW }).map(
				(e) => e.id,
			),
		).toEqual(["newer", "older"]);
	});
});

describe("publicEntries (/whats-new)", () => {
	it("never includes a non-public or future-dated entry", () => {
		const ids = publicEntries(ALL, NOW).map((e) => e.id);
		expect(ids).not.toContain("admin");
		expect(ids).not.toContain("future");
		expect(ids.sort()).toEqual(["everyone", "members"]);
	});

	it("the shipped admin-only entry (promote) is not on the public page", () => {
		const promote = WHATS_NEW_ENTRIES.find(
			(e) => e.id === "2026-09-26-promote",
		);
		expect(promote?.audience).toBe("admins");
		expect(publicEntries(WHATS_NEW_ENTRIES, new Date())).not.toContain(promote);
	});
});

describe("hasUnseenEntries (header dot)", () => {
	it("never opened: any eligible entry is unseen", () => {
		expect(hasUnseenEntries([EVERYONE], new Set())).toBe(true);
	});

	it("nothing eligible: no dot", () => {
		expect(hasUnseenEntries([], new Set())).toBe(false);
	});

	it("every eligible entry seen: no dot", () => {
		expect(
			hasUnseenEntries([EVERYONE, MEMBERS], new Set(["everyone", "members"])),
		).toBe(false);
	});

	it("unreadable state (null): no dot", () => {
		expect(hasUnseenEntries([EVERYONE], null)).toBe(false);
	});

	// The two cases a "seen at" timestamp got wrong. Both replay the real
	// sequence: open the panel (record what it showed), then a new entry
	// merges, then the viewer comes back.
	it("same day: an entry dated today that merges after this morning's open lights the dot", () => {
		const morning = [entry({ id: "2026-10-01-a", date: "2026-10-01" })];
		const seen = new Set(morning.map((e) => e.id)); // opened at 10:00Z
		const afternoon = [
			...morning,
			entry({ id: "2026-10-01-b", date: "2026-10-01" }), // merged 18:00Z
		];
		expect(hasUnseenEntries(morning, seen)).toBe(false);
		expect(hasUnseenEntries(afternoon, seen)).toBe(true);
	});

	it("late merge: an entry dated Monday that merges Wednesday, after a Tuesday open, lights the dot", () => {
		const tuesday = [entry({ id: "2026-09-29-newest", date: "2026-09-29" })];
		const seen = new Set(tuesday.map((e) => e.id));
		const wednesday = [
			...tuesday,
			entry({ id: "2026-09-28-late", date: "2026-09-28" }),
		];
		expect(hasUnseenEntries(wednesday, seen)).toBe(true);
	});

	it("audience decides the dot: an admin entry alone never dots a member", () => {
		const eligible = eligibleEntries([ADMIN], { isAdmin: false, now: NOW });
		expect(hasUnseenEntries(eligible, new Set())).toBe(false);
		expect(
			hasUnseenEntries(
				eligibleEntries([ADMIN], { isAdmin: true, now: NOW }),
				new Set(),
			),
		).toBe(true);
	});

	it("a future-dated entry does not dot anyone", () => {
		expect(
			hasUnseenEntries(
				eligibleEntries([FUTURE], { isAdmin: false, now: NOW }),
				new Set(),
			),
		).toBe(false);
	});
});

describe("isFeatureNew (badges)", () => {
	const feature = entry({ id: "f", featureKey: "account", date: "2026-09-01" });
	const at = (iso: string) => new Date(iso);

	it("new inside the window, not yet seen", () => {
		expect(
			isFeatureNew({
				eligible: [feature],
				featureKey: "account",
				seen: new Set(),
				now: at("2026-09-10T00:00:00Z"),
			}),
		).toBe(true);
	});

	it("clears once used", () => {
		expect(
			isFeatureNew({
				eligible: [feature],
				featureKey: "account",
				seen: new Set(["account"]),
				now: at("2026-09-10T00:00:00Z"),
			}),
		).toBe(false);
	});

	it(`clears ${NEW_WINDOW_DAYS} days after the entry's date`, () => {
		const args = {
			eligible: [feature],
			featureKey: "account",
			seen: new Set<string>(),
		};
		expect(isFeatureNew({ ...args, now: at("2026-09-30T23:59:59Z") })).toBe(
			true,
		);
		expect(isFeatureNew({ ...args, now: at("2026-10-01T00:00:00Z") })).toBe(
			false,
		);
	});

	it("unreadable seen state (null) is never new", () => {
		expect(
			isFeatureNew({
				eligible: [feature],
				featureKey: "account",
				seen: null,
				now: at("2026-09-10T00:00:00Z"),
			}),
		).toBe(false);
	});

	it("an entry the viewer is not eligible for does not badge", () => {
		const adminFeature = { ...feature, audience: "admins" as const };
		const now = at("2026-09-10T00:00:00Z");
		expect(
			isFeatureNew({
				eligible: eligibleEntries([adminFeature], { isAdmin: false, now }),
				featureKey: "account",
				seen: new Set(),
				now,
			}),
		).toBe(false);
	});
});

describe("bannerEntry (public pages)", () => {
	const now = new Date("2026-09-25T00:00:00Z");
	const newer = entry({ id: "newer", date: "2026-09-24" });
	const older = entry({ id: "older", date: "2026-09-10" });

	it("at most one: the newest eligible", () => {
		expect(
			bannerEntry({ entries: [older, newer], dismissed: new Set(), now })?.id,
		).toBe("newer");
	});

	it("respects dismissal, then offers the next", () => {
		expect(
			bannerEntry({
				entries: [older, newer],
				dismissed: new Set(["newer"]),
				now,
			})?.id,
		).toBe("older");
		expect(
			bannerEntry({
				entries: [older, newer],
				dismissed: new Set(["newer", "older"]),
				now,
			}),
		).toBeNull();
	});

	it("never an admin, non-public or future entry", () => {
		const adminPublicish = entry({ id: "a", audience: "admins" });
		const privateOne = entry({ id: "p", public: false });
		const future = entry({ id: "f", date: "2026-09-26" });
		expect(
			bannerEntry({
				entries: [adminPublicish, privateOne, future],
				dismissed: new Set(),
				now,
			}),
		).toBeNull();
	});

	it("nothing older than the window", () => {
		const stale = entry({ id: "stale", date: "2026-07-01" });
		expect(
			bannerEntry({ entries: [stale], dismissed: new Set(), now }),
		).toBeNull();
	});

	it("storage unavailable (null): nothing", () => {
		expect(bannerEntry({ entries: [newer], dismissed: null, now })).toBeNull();
	});
});

describe("stored sets fail silent", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("no localStorage at all (SSR): null", () => {
		vi.stubGlobal("localStorage", undefined);
		expect(readStoredSet("k")).toBeNull();
		expect(() => addToStoredSet("k", "v")).not.toThrow();
	});

	it("a throwing localStorage: null on read, no throw on write", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("SecurityError");
			},
		});
		expect(readStoredSet("k")).toBeNull();
		expect(() => addToStoredSet("k", "v")).not.toThrow();
	});

	it("round-trips, and a malformed value reads as empty", () => {
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
		});
		expect(readStoredSet("k")).toEqual(new Set());
		addToStoredSet("k", "a");
		addToStoredSet("k", "b");
		expect(readStoredSet("k")).toEqual(new Set(["a", "b"]));
		store.set("k", "{not json");
		expect(readStoredSet("k")).toEqual(new Set());
	});
});

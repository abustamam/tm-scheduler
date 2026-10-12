/**
 * Test support for the Easy-Speak export (#1047): loads the committed fixtures
 * and serves them as a fake Easy-Speak for the walk. Not a test itself.
 */
import { readFileSync } from "node:fs";
import { DOMParser } from "linkedom";
import { norm } from "./easy-speak-text";
import { type Identity, identityFromDoc, runExport, type WalkStore } from "./easy-speak-walk";

const DIR = new URL("./__fixtures__/easy-speak/", import.meta.url);

export const readFixture = (name: string): string =>
	readFileSync(new URL(name, DIR), "utf8");

export const fixturePath = (name: string): URL => new URL(name, DIR);

/** linkedom's document, typed as the DOM one the parsers take. */
export const parseHtml = (html: string): Document =>
	new DOMParser().parseFromString(html, "text/html") as unknown as Document;

export const fixtureDoc = (name: string): Document => parseHtml(readFixture(name));

/**
 * What a phone number and an email look like. NOT global: `.test()` on a global
 * regex keeps `lastIndex` between calls and skips matches. Build a `g` copy
 * from `.source` where every match is wanted.
 */
export const PHONE = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+\d{1,3}[\s.-]\d[\d\s.-]{6,}\d/;
export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/**
 * A run of two or more capitalised words, the shape of a person's name ("Dana
 * Vexford"). It is also the shape of a role, a project and a page heading, which
 * is why `non-person-phrases.json` exists. An initial ("A. Fixtureperson") counts.
 */
export const NAME_SHAPED = /\b[A-Z](?:[A-Za-z'\u2019-]+|\.)(?:\s+(?:[A-Z][A-Za-z'\u2019-]+|[A-Z]\.))+/g;

/** Every name-shaped run in the text a reader sees, and in the attributes a reader can see (title, alt, value...). */
export function nameShapedRuns(doc: Document): string[] {
	const out: string[] = [];
	const scan = (t: string | null | undefined) => {
		for (const m of norm(t).match(NAME_SHAPED) ?? []) out.push(m.trim());
	};
	for (const el of Array.from(doc.querySelectorAll("script, style"))) el.remove();
	const walk = (n: Node) => {
		if (n.nodeType === 3) return scan(n.textContent);
		if (n.nodeType === 1) {
			for (const a of ["title", "alt", "value", "content", "placeholder"]) scan((n as Element).getAttribute(a));
		}
		for (const c of Array.from(n.childNodes ?? [])) walk(c);
	};
	if (doc.documentElement) walk(doc.documentElement);
	return out;
}

/** The same, over every string in a JSON value. */
export function nameShapedRunsInJson(value: unknown): string[] {
	const out: string[] = [];
	const walk = (v: unknown) => {
		if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === "object") Object.values(v).forEach(walk);
		else if (typeof v === "string") out.push(...(norm(v).match(NAME_SHAPED) ?? []).map((m) => m.trim()));
	};
	walk(value);
	return out;
}

/** The meeting list with no meetings: what Easy-Speak returns for a year the club did not exist. */
export function emptyMeetingList(): string {
	const doc = fixtureDoc("meeting-list.html");
	for (const a of Array.from(
		doc.querySelectorAll('table.forumline a[href*="view_meeting.php?t="]'),
	)) {
		let tr: Element | null = a;
		while (tr && tr.tagName !== "TR") tr = tr.parentElement;
		tr?.remove();
	}
	return doc.toString();
}

/** The meeting list as Easy-Speak shows it for a year with exactly these meetings. */
export function meetingListOf(ids: string[]): string {
	const doc = fixtureDoc("meeting-list.html");
	const rows: Element[] = [];
	for (const a of Array.from(doc.querySelectorAll('table.forumline a[href*="view_meeting.php?t="]'))) {
		let tr: Element | null = a;
		while (tr && tr.tagName !== "TR") tr = tr.parentElement;
		if (tr && !rows.includes(tr)) rows.push(tr);
	}
	const [first, ...rest] = rows;
	for (const r of rest) r.remove();
	if (!first) throw new Error("meeting-list.html has no meeting rows");
	for (const id of ids) {
		const copy = first.cloneNode(true) as Element;
		for (const a of Array.from(copy.querySelectorAll('a[href*="view_meeting.php?t="]'))) {
			a.setAttribute("href", (a.getAttribute("href") ?? "").replace(/t=\d+/, `t=${id}`));
		}
		first.parentElement?.insertBefore(copy, first);
	}
	first.remove();
	return doc.toString();
}

/** A request form for a speech that has no introduction yet. */
export function blankRequestForm(speechId: string): string {
	return readFixture("speech-request-intro.html")
		.replace(/Our next speaker grows tomatoes[^<"]*/g, "")
		.replace("1473688", speechId);
}

export interface FakeRequest {
	url: string;
	method: string;
	body: string | null;
	startedAt: number;
}

/**
 * The fixtures as a site: every URL the walk asks for maps to a page. The
 * meeting list answers for 2026 only; any other year is empty.
 */
export function fakeEasySpeak(opts: {
	clock: () => number;
	log: FakeRequest[];
	failOn?: (url: string) => boolean;
	/** The body to answer a request with instead of the fixture (a 200). First non-undefined wins. */
	override?: (url: string, init: RequestInit) => string | undefined;
	/** The meeting list for a year, instead of "the fixture's list for 2026, empty otherwise". */
	listByYear?: Record<string, string>;
	/** Meeting ids beyond the three fixtures, and the fixture file each one is served from. */
	extraMeetings?: Record<string, string>;
	/** Throw instead of answering, for the request this matches (a network failure). */
	throwOn?: (url: string) => boolean;
}) {
	const meetings: Record<string, string> = {
		"644360": "meeting-upcoming.html",
		"644304": "meeting-completed.html",
		"644363": "meeting-table-topics.html",
		...opts.extraMeetings,
	};
	const charts: Record<string, string> = {
		"1": "chart-1-role-history.html",
		"4": "chart-4-roles-by-member.html",
		"7": "chart-7-visitors-introduced.html",
		"8": "chart-8-mentors.html",
	};
	const page = (body: string) => ({
		ok: true,
		status: 200,
		text: async () => body,
	});
	return async (url: string, init: RequestInit) => {
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? init.body : null;
		opts.log.push({ url, method, body, startedAt: opts.clock() });
		if (opts.throwOn?.(url)) throw new Error("Failed to fetch");
		if (opts.failOn?.(url)) return { ok: false, status: 500, text: async () => "" };
		const forced = opts.override?.(url, init);
		if (forced !== undefined) return page(forced);
		const u = new URL(url);
		const p = u.pathname;
		if (p === "/clubdata.php") return page(readFixture("club-data.html"));
		if (p === "/memberlist.php") return page(readFixture("member-list.html"));
		if (p === "/meeting_list.php") {
			const year = new URLSearchParams(body ?? "").get("start_year");
			if (opts.listByYear) return page(opts.listByYear[year ?? ""] ?? emptyMeetingList());
			return page(year === "2026" ? readFixture("meeting-list.html") : emptyMeetingList());
		}
		if (p === "/view_meeting.php") {
			const file = meetings[u.searchParams.get("t") ?? ""];
			if (file) return page(readFixture(file));
		}
		if (p === "/tm_all_speeches.php") return page(readFixture("speech-list.html"));
		if (p === "/request_speech.php") {
			const s = u.searchParams.get("s") ?? "";
			return page(s === "1473688" ? readFixture("speech-request-intro.html") : blankRequestForm(s));
		}
		if (p === "/memberchart.php") {
			const file = charts[u.searchParams.get("chart") ?? ""];
			if (file) return page(readFixture(file));
		}
		if (p === "/my_evaluations.php") return page(readFixture("my-evaluations.html"));
		if (p === "/api/v1/evaluations.php/my-evaluations") return page(readFixture("my-evaluations.json"));
		const ev = /^\/api\/v1\/evaluations\.php\/eval\/(\d+)$/.exec(p);
		if (ev) return page(readFixture(`evaluation-${ev[1]}.json`));
		return { ok: false, status: 404, text: async () => "not found" };
	};
}

// ------------------------------------------------------------------ walk harness

/** A memory store that survives "reloads": the same object is handed to the next run. */
export function memoryStore(): WalkStore & { data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	return {
		data,
		get: async (k) => data.get(k),
		set: async (k, v) => {
			data.set(k, JSON.parse(JSON.stringify(v)));
		},
		update: async (k, fn) => {
			const next = fn(data.get(k));
			if (next !== undefined) data.set(k, JSON.parse(JSON.stringify(next)));
			return data.get(k);
		},
		clear: async () => data.clear(),
	};
}

/** A clock that only moves when the walk sleeps or a request "takes time". */
export function clock(start = Date.UTC(2026, 9, 12, 12, 0, 0)) {
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

export type FakeSiteOptions = Omit<Parameters<typeof fakeEasySpeak>[0], "clock" | "log">;

/** Who the fixtures are signed in as: the club and account the walk exports by default. */
export const FIXTURE_IDENTITY: Identity = (() => {
	const id = identityFromDoc(fixtureDoc("club-data.html"));
	if (!id) throw new Error("club-data.html shows no club id or username");
	return id;
})();

/** One walker over the fake site. `owner` names it in the lease; a second harness on the same `store` is a second tab. */
export function setup(opts: FakeSiteOptions & { store?: ReturnType<typeof memoryStore>; owner?: string; clock?: ReturnType<typeof clock>; identity?: Identity } = {}) {
	const c = opts.clock ?? clock();
	const log: FakeRequest[] = [];
	const store = opts.store ?? memoryStore();
	let inFlight = 0;
	let maxInFlight = 0;
	const { store: _s, owner: _o, clock: _c, identity: _i, ...siteOpts } = opts;
	const site = fakeEasySpeak({ clock: c.now, log, ...siteOpts });
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
	const progress: string[] = [];
	const run = () =>
		runExport({
			fetchImpl,
			parseHtml,
			store,
			owner: opts.owner ?? "tab-a",
			identity: opts.identity ?? FIXTURE_IDENTITY,
			onProgress: (p) => progress.push(p.label),
			sleep: c.sleep,
			now: c.now,
		});
	return { run, log, store, c, progress, maxInFlight: () => maxInFlight };
}

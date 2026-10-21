/**
 * Test support for the Easy-Speak export (#1047): loads the committed fixtures
 * and serves them as a fake Easy-Speak for the walk. Not a test itself.
 */
import { readFileSync } from "node:fs";
import { DOMParser } from "linkedom";
import { stripCredentials } from "./easy-speak-parse";
import { norm } from "./easy-speak-text";
import { type ExportResult, type Identity, identityFromDoc, runExport, type WalkStore } from "./easy-speak-walk";

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

// ------------------------------------------------------------------ the anonymisation guard

const fakeNames = JSON.parse(readFixture("fake-names.json")) as { names: string[]; usernames: string[] };
const nonPersonPhrases = JSON.parse(readFixture("non-person-phrases.json")) as Record<string, string[] | string>;

/** Every fake person name a fixture may carry, in the order `fake-names.json` lists them. */
export const FAKE_NAMES: readonly string[] = fakeNames.names;
/** The username a fixture carries, and the one it carries instead when the input's own username is that very word (so an output never equals its input). */
export const FAKE_USERNAME: string = fakeNames.usernames[0];
export const ALT_USERNAME = `${FAKE_USERNAME}-alt`;

const FAKE_NAME_SET = new Set(FAKE_NAMES);
/** The first names and the rest-of-name parts of the invented names: the generator pairs any first with any last, so the pool cannot run out on a realistic page. */
export const FAKE_FIRSTS: readonly string[] = [...new Set(FAKE_NAMES.map((n) => n.split(" ")[0]))];
export const FAKE_LASTS: readonly string[] = [...new Set(FAKE_NAMES.map((n) => n.slice(n.indexOf(" ") + 1)))];
const FIRST_SET = new Set(FAKE_FIRSTS);
const LAST_SET = new Set(FAKE_LASTS);
/** An invented name: one of the listed ones, or any invented first name with any invented last name. */
export const isFakeName = (t: string): boolean => FAKE_NAME_SET.has(t) || (t.includes(" ") && FIRST_SET.has(t.split(" ")[0]) && LAST_SET.has(t.slice(t.indexOf(" ") + 1)));
const PHRASE_SET = new Set(
	Object.entries(nonPersonPhrases)
		.filter(([k]) => k !== "_about")
		.flatMap(([, v]) => v as string[]),
);

/**
 * Every place a person's id rides in markup: any `…user…`/`…member…`/`…person…`/`…uid…` or bare
 * `u` parameter (`=` or percent-encoded), and the attendance rows' name attributes. Group 1 is
 * the prefix, group 2 the id. Global: reset with `matchAll` or `replace`, never `.test`.
 */
const PERSON_ID_PARAM = /((?<![A-Za-z])(?<!(?<!%[0-9a-f])[0-9])(?:u|[a-z_]*(?:user|member|person|uid)[a-z_]*)(?:=|%3[dD])|attend_image1?\[|available\[|rec\[|available_)(\d+)/gi;

/** A phone with or without separators, a leading country code, or a tel: link's digits. */
const LOOSE_PHONE = /(?<!\d)(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)|\+\d{1,3}[\s.-]\d[\d\s.-]{6,}\d|\+\d{10,14}(?!\d)/g;
// A US number's area code starts 2-9, so a bare 10-digit run starting 1 (a unix timestamp) is not one.

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">", commat: "@", period: ".", num: "#", lpar: "(", rpar: ")",
	hyphen: "-", equals: "=", plus: "+", colon: ":", sol: "/", lowbar: "_", lsqb: "[", rsqb: "]", comma: ",",
};

/** HTML entities and percent-escapes undone (up to three layers), so `&#64;` and `%40` read as `@`. */
function decodeMarkup(s: string): string {
	let cur = s;
	for (let i = 0; i < 3; i++) {
		const next = cur
			.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
				if (e[0] === "#") {
					const n = e[1].toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
					return n === 160 ? " " : n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
				}
				return NAMED_ENTITIES[e.toLowerCase()] ?? m;
			})
			.replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
				try {
					return decodeURIComponent(m);
				} catch {
					return m;
				}
			});
		if (next === cur) break;
		cur = next;
	}
	return cur;
}

/** The digits of a phone, without a leading country 1. */
const phoneDigits = (p: string): string => {
	const d = p.replace(/\D/g, "");
	return d.length === 11 && d[0] === "1" ? d.slice(1) : d;
};
/** The fictional range fixtures use: 555-010x-xxxx, here written (555) 010-xxxx. */
const isFakePhoneDigits = (d: string): boolean => /^555010\d{4}$/.test(d);

/** A real value the page must no longer carry (what the human anonymising it replaced). */
interface FixtureOriginal {
	/** Club ids and numbers, as the archive names them. */
	clubIds?: string[];
	/** Real person names, their aliases (initials) and tokens. */
	names?: string[];
	/** Club names, venues, addresses. */
	terms?: string[];
	/** Real person ids. */
	personIds?: string[];
}
export interface FixtureCheckOptions {
	/** The page is one of the two contact pages, the only ones that may carry a phone. Default false. */
	contactPage?: boolean;
	original?: FixtureOriginal;
}

const PHRASE_PARTS: string[] = [...PHRASE_SET, ...FAKE_NAMES];

/** Words every fake name and allowed phrase already uses: a real name token equal to one is not a leak. */
// The allowed phrases' words only: a real name's word that is also a role word ("Timer") is the role. A fake NAME's words are not exempt: the generator never gives a fake a word the page carries, so a real name word found next to a fake one is the real one surviving.
const SHARED_WORDS: ReadonlySet<string> = new Set([...PHRASE_SET].flatMap((p) => p.toLowerCase().split(/[\s-]+/)));

/** Can a club id (or number) be matched as a bare number, or only next to a quote, `=` or `%3D`? */
function clubIdRegex(id: string): RegExp {
	const e = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return id.length >= 4 ? new RegExp(`(?<!\\d)${e}(?!\\d)`, "g") : new RegExp(`(?<==|%3[dD]|["'])${e}(?=["'&;#\\s>]|%26)`, "g");
}

/**
 * What is wrong with a candidate fixture page, as plain sentences; `[]` means it may be committed.
 * It is a net, not a gate: a human reads the file before committing it.
 *
 * The same checks `easy-speak-fixtures.test.ts` runs over the committed pages (that file keeps its
 * own copy; a test here runs this over every committed page to hold the two together), made
 * stricter where a bypass was found: person links and the header name are fake, person ids (under
 * any parameter name) are 900001-900999, one fake username, no leftover evaluator history, every
 * name-shaped run in the text AND in every attribute is a fake name or an allowed phrase, phones
 * are `(555) 010-xxxx` and only on a contact page, no email. Everything but the first two is read
 * from the entity- and percent-decoded markup, case-insensitively. With `original`, the real
 * values that were replaced must be gone too.
 */
export function fixtureViolations(html: string, opts: FixtureCheckOptions = {}): string[] {
	const out: string[] = [];
	const doc = parseHtml(html);
	const decoded = decodeMarkup(html);
	for (const a of Array.from(doc.querySelectorAll("a"))) {
		const attrs = decodeMarkup(`${a.getAttribute("href") ?? ""} ${a.getAttribute("onclick") ?? ""}`);
		if (!/(?:[?&;]|^|\s)u=\d+/.test(attrs)) continue;
		const t = stripCredentials(norm(a.textContent));
		if (t === "" || /^(Request a Speech\.\.\.|Accept|TBA)$/.test(t)) continue;
		if (!isFakeName(t)) out.push(`person link names someone who is not a fake name: "${t}"`);
	}
	const header = /Welcome back\s+(.+?)\s*\[/.exec(norm(doc.body?.textContent));
	if (header && !isFakeName(stripCredentials(header[1]))) out.push(`header names "${header[1]}"`);
	for (const text of [html, decoded]) {
		for (const m of text.matchAll(PERSON_ID_PARAM)) {
			const n = Number(m[2]);
			if (n < 900_001 || n > 900_999) out.push(`person id ${n} is outside 900001-900999`);
		}
	}
	if (/Accepted by|Previous Evaluators|I am NOT attending this meeting \(/.test(decoded)) out.push("leftover evaluator history");
	for (const m of decoded.matchAll(/\[([A-Za-z0-9_-]+)\](?=\s|$)/g)) {
		if (m[1] !== FAKE_USERNAME && m[1] !== ALT_USERNAME && !/^\d+$/.test(m[1])) out.push(`username "${m[1]}" is not ${FAKE_USERNAME}`);
	}
	for (const r of nameShapedRuns(parseHtml(html))) {
		if (!isFakeName(r) && !PHRASE_SET.has(r)) out.push(`name-shaped text "${r}" is neither a fake name nor an allowed phrase`);
	}
	// Every attribute (href, src, onclick, data-*, id, title...), decoded: a name in a URL is still a name.
	for (const el of Array.from(doc.querySelectorAll("*"))) {
		for (const a of Array.from(el.attributes ?? [])) {
			for (const m of decodeMarkup(a.value).replace(/\+/g, " ").match(NAME_SHAPED) ?? []) {
				const r = m.trim().replace(/['\u2019-]+$/, "");
				// Attributes carry fragments of a phrase (an id, a javascript: call): a part of one is fine.
				if (!isFakeName(r) && !PHRASE_SET.has(r) && !PHRASE_PARTS.some((p) => p.includes(r))) out.push(`name-shaped text "${r}" in the ${a.name} attribute is neither a fake name nor an allowed phrase`);
			}
		}
	}
	for (const m of html.match(new RegExp(PHONE.source, "g")) ?? []) {
		if (!/^\(555\) 010-\d{4}$/.test(m)) out.push(`phone "${m}" is outside (555) 010-xxxx`);
	}
	const loose = decoded.match(LOOSE_PHONE) ?? [];
	for (const m of loose) if (!isFakePhoneDigits(phoneDigits(m))) out.push(`phone "${m.trim()}" is outside (555) 010-xxxx`);
	if ((loose.length > 0 || PHONE.test(html)) && !opts.contactPage) out.push("a phone on a page that is not a contact page (only club-data.html and member-list.html may carry one)");
	if (EMAIL.test(html) || EMAIL.test(decoded)) out.push("an email address");
	if (/mailto:/i.test(decoded)) out.push("a mailto: link");
	if (opts.original) out.push(...originalLeaks(decoded, opts.original));
	return out;
}

function originalLeaks(decoded: string, o: FixtureOriginal): string[] {
	const out: string[] = [];
	const view = decoded.replace(/[+\s]+/g, " ").toLowerCase();
	for (const id of o.clubIds ?? []) {
		if (id && decoded.match(clubIdRegex(id))) out.push(`the club id ${id} is still in the page`);
	}
	for (const id of o.personIds ?? []) {
		if (id && id.length >= 4 && new RegExp(`(?<!\\d)${id}(?!\\d)`).test(decoded)) out.push(`the person id ${id} is still in the page`);
	}
	for (const t of o.terms ?? []) {
		if (t && view.includes(t.replace(/[+\s]+/g, " ").toLowerCase())) out.push(`"${t}" is still in the page`);
	}
	for (const n of o.names ?? []) {
		const whole = n.replace(/[+\s]+/g, " ").toLowerCase();
		// The whole name, then each word of it: a bare "Riley" is as real as "Riley Moonstone".
		for (const k of new Set([whole, ...whole.split(/[\s,]+/).filter((w) => w.length >= 3 && !SHARED_WORDS.has(w))])) {
			if (k.length < 3) continue;
			const e = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`(?<![a-z])${e}(?![a-z])`).test(view)) out.push(`the real name "${n}" is still in the page (as "${k}")`);
		}
	}
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

/** A page of the fixtures as the server would send it to another account or club. */
export function asIdentity(html: string, who: Identity): string {
	return html
		.replaceAll(FIXTURE_IDENTITY.username, who.username)
		.replaceAll(`c=${FIXTURE_IDENTITY.esClubId}`, `c=${who.esClubId}`)
		.replaceAll(`name="cached_club" value="${FIXTURE_IDENTITY.esClubId}"`, `name="cached_club" value="${who.esClubId}"`);
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
	/** The status a `failOn` request answers with. Default 500. */
	failStatus?: number;
	/** The body to answer a request with instead of the fixture (a 200). First non-undefined wins. */
	override?: (url: string, init: RequestInit) => string | undefined;
	/** The meeting list for a year, instead of "the fixture's list for 2026, empty otherwise". */
	listByYear?: Record<string, string>;
	/** Meeting ids beyond the three fixtures, and the fixture file each one is served from. */
	extraMeetings?: Record<string, string>;
	/** Throw instead of answering, for the request this matches (a network failure). */
	throwOn?: (url: string) => boolean;
	/**
	 * Who the site answers as (the cookies the browser sends): every page shows this club and
	 * account. A function is asked per request with its 0-based position, for a switch mid-walk.
	 * Default: the fixtures' own.
	 */
	as?: Identity | ((requestIndex: number, url: string) => Identity);
	/** Where a fixture file's text comes from, instead of the committed file (the generator's round-trip test serves rewritten pages). */
	read?: (file: string) => string;
}) {
	const read = opts.read ?? readFixture;
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
	return async (url: string, init: RequestInit) => {
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? init.body : null;
		const requestIndex = opts.log.length;
		opts.log.push({ url, method, body, startedAt: opts.clock() });
		const who = typeof opts.as === "function" ? opts.as(requestIndex, url) : opts.as;
		const page = (html: string) => ({
			ok: true,
			status: 200,
			text: async () => (who ? asIdentity(html, who) : html),
		});
		if (opts.throwOn?.(url)) throw new Error("Failed to fetch");
		if (opts.failOn?.(url)) return { ok: false, status: opts.failStatus ?? 500, text: async () => "" };
		const forced = opts.override?.(url, init);
		if (forced !== undefined) return page(forced);
		const u = new URL(url);
		const p = u.pathname;
		if (p === "/clubdata.php") return page(read("club-data.html"));
		if (p === "/memberlist.php") return page(read("member-list.html"));
		if (p === "/meeting_list.php") {
			const year = new URLSearchParams(body ?? "").get("start_year");
			if (opts.listByYear) return page(opts.listByYear[year ?? ""] ?? emptyMeetingList());
			return page(year === "2026" ? read("meeting-list.html") : emptyMeetingList());
		}
		if (p === "/view_meeting.php") {
			const file = meetings[u.searchParams.get("t") ?? ""];
			if (file) return page(read(file));
		}
		if (p === "/tm_all_speeches.php") return page(read("speech-list.html"));
		if (p === "/request_speech.php") {
			const s = u.searchParams.get("s") ?? "";
			return page(s === "1473688" ? read("speech-request-intro.html") : blankRequestForm(s));
		}
		if (p === "/memberchart.php") {
			const file = charts[u.searchParams.get("chart") ?? ""];
			if (file) return page(read(file));
		}
		if (p === "/my_evaluations.php") return page(read("my-evaluations.html"));
		if (p === "/api/v1/evaluations.php/my-evaluations") return page(read("my-evaluations.json"));
		const ev = /^\/api\/v1\/evaluations\.php\/eval\/(\d+)$/.exec(p);
		if (ev) return page(read(`evaluation-${ev[1]}.json`));
		return { ok: false, status: 404, text: async () => "not found" };
	};
}

// ------------------------------------------------------------------ replay

/**
 * Replay a live-site failure: serve the given fixture pages in place of the usual ones and
 * return the walk harness (`run`, `log`, `store`...). Each key is a path, or a path with its
 * query ("/request_speech.php?s=1473688"); a bare path answers every request to it, a key with
 * a query only the requests that carry those parameters (others, like `mode`, may be there too).
 * The value is a fixture file name. Every other URL is served as `fakeEasySpeak` serves it, so a
 * regression test for a live bug is the offending page, anonymised by hand (see
 * `__fixtures__/easy-speak/README.md`), and a few lines:
 *
 *     const r = replay({ "/view_meeting.php?t=644360": "meeting-regression-123.html" });
 *     expect((await r.run()).bundle.meetings...).
 */
export function replay(pages: Record<string, string>, opts: NonNullable<Parameters<typeof setup>[0]> = {}) {
	const entries = Object.entries(pages).map(([key, file]) => {
		const u = new URL(key, "https://easy-speak.org");
		return { path: u.pathname, query: key.includes("?") ? u.searchParams : null, file };
	});
	const { override, ...rest } = opts;
	return setup({
		...rest,
		override: (url, init) => {
			const u = new URL(url);
			// A query-carrying key is the more specific; it wins over a bare path.
			const hit =
				entries.find((e) => e.path === u.pathname && e.query !== null && [...e.query].every(([k, v]) => u.searchParams.get(k) === v)) ??
				entries.find((e) => e.path === u.pathname && e.query === null);
			return hit ? readFixture(hit.file) : override?.(url, init);
		},
	});
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
		transact: async (keys, fn) => {
			const write = fn(Object.fromEntries(keys.map((k) => [k, data.get(k)])));
			if (!write) return false;
			if (write.clear) data.clear();
			for (const [k, v] of Object.entries(write.set ?? {})) data.set(k, JSON.parse(JSON.stringify(v)));
			return true;
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
	// The default site answers as whoever the walker says it is; a test that wants the two to
	// differ (the user switched account mid-walk) passes `as`.
	const site = fakeEasySpeak({ clock: c.now, log, as: opts.identity, ...siteOpts });
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

/** An export result minus what the clock stamps: the export time and each page's fetch time. */
export const stripClock = (r: ExportResult) => ({
	bundle: { ...r.bundle, exportedAt: "" },
	archive: {
		...r.archive,
		exportedAt: "",
		pages: r.archive.pages.map((p) => ({ ...p, fetchedAt: "" })),
	},
});

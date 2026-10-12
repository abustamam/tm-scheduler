/**
 * The Easy-Speak export walk (#1047). Fetch, parse and assemble are injected, so
 * the whole thing runs in Node under test and in the content script for real.
 *
 * It is a polite, sequential, resumable crawl of one club, in the user's own
 * session:
 *
 *  - ONE request at a time, and at least `minGapMs` (1s) between request starts.
 *    The walk awaits every request before it starts the next; the gap is checked
 *    against the injected clock.
 *  - Every page it fetches is written to the store before the next request. A
 *    reload mid-walk starts the same walk again, and each finished page is read
 *    back from the store with no request and no wait. That is the resume:
 *    there is no separate "where was I" state to get wrong.
 *  - `memberlist.php` and `clubdata.php` carry phone numbers. They are parsed
 *    and only the parsed result is stored (for resume) and exported; their HTML
 *    is never kept, in the store or in `raw`.
 *  - All or nothing: a page that fails, or is not the page it should be (the
 *    login form, say), aborts the walk with a message naming it. The store keeps
 *    what was fetched, so pressing Resume costs nothing already done. The one
 *    exception is evaluations, which are best-effort (a member sees only their
 *    own, usually none).
 */
import {
	type AssembleInput,
	type EasySpeakBundleV1,
	EASY_SPEAK_ORIGIN,
	type EsEvaluation,
	type EsRawPage,
	type ParsedSpeechRow,
	type RequestFormInfo,
	assembleBundle,
	bundleFileName,
	isContactPage,
} from "./easy-speak-bundle";
import {
	parseClubData,
	parseEsClubId,
	parseEvaluation,
	parseEvaluationList,
	parseMeeting,
	parseMeetingList,
	parseMemberList,
	parseMentoring,
	parseRequestForm,
	parseSpeechList,
	parseViewer,
	parseVisitorsIntroduced,
} from "./easy-speak-parse";

export const MIN_GAP_MS = 1000;
/** A stored session older than this is not resumed: the club has moved on. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Stop walking back through years after this many empty ones in a row (once a meeting has been seen). */
const EMPTY_YEARS_TO_STOP = 2;
const EARLIEST_YEAR = 2004;

export interface WalkStore {
	get(key: string): Promise<unknown | undefined>;
	set(key: string, value: unknown): Promise<void>;
	clear(): Promise<void>;
}

interface FetchResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

export interface WalkDeps {
	fetchImpl: (url: string, init: RequestInit) => Promise<FetchResponseLike>;
	parseHtml: (html: string) => Document;
	store: WalkStore;
	sleep: (ms: number) => Promise<void>;
	/** Epoch milliseconds. */
	now: () => number;
	onProgress?: (p: Progress) => void;
	/** Test seam; the real walk never goes below one second. */
	minGapMs?: number;
}

export interface Progress {
	done: number;
	total: number;
	label: string;
}

export interface Session {
	startedAt: number;
	lastActivityAt: number;
	pages: number;
}

interface Entry {
	url: string;
	fetchedAt: string;
	/** Present for every page except the two contact pages. */
	body?: string;
	/** Present only for the two contact pages. */
	parsed?: unknown;
}

const META = "meta";
const entryKey = (key: string) => `page:${key}`;

/** The unfinished session in `store`, if one is young enough to resume. */
export async function readSession(
	store: WalkStore,
	now: number,
): Promise<Session | null> {
	const s = (await store.get(META)) as Session | undefined;
	if (!s || now - s.lastActivityAt > SESSION_TTL_MS) return null;
	return s;
}

class WalkError extends Error {}

export async function runExport(
	deps: WalkDeps,
): Promise<{ bundle: EasySpeakBundleV1; fileName: string }> {
	const { store, now } = deps;
	const gap = deps.minGapMs ?? MIN_GAP_MS;

	const existing = await readSession(store, now());
	let session: Session;
	if (existing) {
		session = existing;
	} else {
		await store.clear();
		session = { startedAt: now(), lastActivityAt: now(), pages: 0 };
		await store.set(META, session);
	}

	let lastStart = Number.NEGATIVE_INFINITY;
	let done = 0;
	let total = 0;
	const raw: EsRawPage[] = [];
	const progress = (label: string) => deps.onProgress?.({ done, total, label });

	/**
	 * Fetch (or read back) one page, parse it, and store it. `contact` pages keep
	 * only the parsed value.
	 */
	async function page<T>(spec: {
		key: string;
		url: string;
		init?: RequestInit;
		label: string;
		/** Shown in `raw` instead of `url`, for a POST whose parameters are not in the URL. */
		rawUrl?: string;
		json?: boolean;
		parse: (body: string, doc: Document | null) => T;
	}): Promise<T> {
		const contact = isContactPage(spec.url);
		const cached = (await store.get(entryKey(spec.key))) as Entry | undefined;
		let entry = cached;
		let value: T;
		if (!entry) {
			const wait = lastStart + gap - now();
			if (wait > 0) await deps.sleep(wait);
			lastStart = now();
			progress(spec.label);
			let res: FetchResponseLike;
			try {
				res = await deps.fetchImpl(spec.url, {
					credentials: "include",
					...(spec.json ? { headers: { Accept: "application/json" } } : {}),
					...spec.init,
				});
			} catch (err) {
				throw new WalkError(
					`Easy-Speak request failed (${spec.label}): ${(err as Error).message}`,
				);
			}
			if (!res.ok) {
				throw new WalkError(
					`Easy-Speak returned ${res.status} for ${spec.label}.`,
				);
			}
			const body = await res.text();
			const doc = spec.json ? null : deps.parseHtml(body);
			if (doc && parseViewer(doc).username === null) {
				throw new WalkError(
					`${spec.label} is not a signed-in Easy-Speak page. Sign in to Easy-Speak, then press Resume.`,
				);
			}
			value = spec.parse(body, doc);
			entry = {
				url: spec.rawUrl ?? spec.url,
				fetchedAt: new Date(now()).toISOString(),
				...(contact ? { parsed: value } : { body }),
			};
			await store.set(entryKey(spec.key), entry);
			session = { ...session, lastActivityAt: now(), pages: session.pages + 1 };
			await store.set(META, session);
		} else if (contact) {
			value = entry.parsed as T;
		} else {
			const body = entry.body ?? "";
			value = spec.parse(body, spec.json ? null : deps.parseHtml(body));
		}
		if (!contact && entry.body !== undefined) {
			raw.push({ url: entry.url, fetchedAt: entry.fetchedAt, html: entry.body });
		}
		done += 1;
		progress(spec.label);
		return value;
	}

	const get = (path: string) => `${EASY_SPEAK_ORIGIN}/${path}`;

	// ---- the club, and who is exporting
	total += 2;
	const clubPage = await page({
		key: "clubdata",
		url: get("clubdata.php"),
		label: "club details",
		parse: (_b, doc) => {
			if (!doc) throw new WalkError("clubdata.php was not HTML.");
			const club = parseClubData(doc);
			const viewer = parseViewer(doc);
			const esClubId = parseEsClubId(doc);
			if (!esClubId) throw new WalkError("Could not find the club id on clubdata.php.");
			return { club, viewer, esClubId };
		},
	});
	const memberPage = await page({
		key: "memberlist",
		url: get("memberlist.php"),
		label: "member list",
		parse: (_b, doc) => {
			if (!doc) throw new WalkError("memberlist.php was not HTML.");
			return parseMemberList(doc);
		},
	});
	if (memberPage.pages > 1) {
		throw new WalkError(
			`The member list has ${memberPage.pages} pages; the export reads one. Ask for this to be added.`,
		);
	}
	const tz = clubPage.club.timezone;

	// ---- every meeting: walk the list year by year, newest first, back to the first
	const meetingIds: string[] = [];
	const thisYear = new Date(now()).getUTCFullYear();
	let emptyRun = 0;
	for (let year = thisYear + 1; year >= EARLIEST_YEAR; year--) {
		total += 1;
		const ids = await page({
			key: `list:${year}`,
			url: get("meeting_list.php"),
			rawUrl: get(
				`meeting_list.php#POST mode=roles&start_month=01&start_year=${year}&end_month=12&end_year=${year}`,
			),
			label: `meetings in ${year}`,
			init: {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					mode: "roles",
					start_month: "01",
					start_year: String(year),
					end_month: "12",
					end_year: String(year),
				}).toString(),
			},
			parse: (_b, doc) => (doc ? parseMeetingList(doc) : []),
		});
		for (const id of ids) if (!meetingIds.includes(id)) meetingIds.push(id);
		emptyRun = ids.length === 0 ? emptyRun + 1 : 0;
		if (meetingIds.length > 0 && emptyRun >= EMPTY_YEARS_TO_STOP) break;
	}
	if (meetingIds.length === 0) {
		throw new WalkError("Easy-Speak's meeting list showed no meetings for this club.");
	}

	total += meetingIds.length;
	const meetings = [];
	for (const [i, id] of meetingIds.entries()) {
		const m = await page({
			key: `meeting:${id}`,
			url: get(`view_meeting.php?t=${id}`),
			label: `meeting ${i + 1} of ${meetingIds.length}`,
			parse: (_b, doc) => (doc ? parseMeeting(doc, id, tz) : null),
		});
		if (!m) throw new WalkError(`Meeting ${id} is not a readable meeting page.`);
		meetings.push(m);
	}

	// ---- speeches, and the request form of each one the session can see
	total += 1;
	const speechRows: ParsedSpeechRow[] = await page({
		key: "speeches",
		url: get("tm_all_speeches.php"),
		label: "speech list",
		parse: (_b, doc) => (doc ? parseSpeechList(doc) : []),
	});
	const requestForms = new Map<string, RequestFormInfo>();
	const formPaths = [
		...new Set(speechRows.map((r) => r.requestFormPath).filter((p): p is string => !!p)),
	];
	total += formPaths.length;
	for (const [i, path] of formPaths.entries()) {
		const form = await page({
			key: `request:${path}`,
			url: get(path),
			label: `speech request ${i + 1} of ${formPaths.length}`,
			parse: (_b, doc) => (doc ? parseRequestForm(doc) : null),
		});
		if (form?.esSpeechId) requestForms.set(form.esSpeechId, form);
	}

	// ---- member charts: role history and roles by member are kept only as raw
	total += 4;
	await page({
		key: "chart:1",
		url: get("memberchart.php?chart=1"),
		label: "role history",
		parse: () => null,
	});
	await page({
		key: "chart:4",
		url: get("memberchart.php?chart=4"),
		label: "roles by member",
		parse: () => null,
	});
	const visitorsIntroduced = await page({
		key: "chart:7",
		url: get("memberchart.php?chart=7"),
		label: "visitors introduced",
		parse: (_b, doc) => (doc ? parseVisitorsIntroduced(doc) : []),
	});
	const mentoring = await page({
		key: "chart:8",
		url: get("memberchart.php?chart=8"),
		label: "mentors",
		parse: (_b, doc) =>
			doc
				? (() => {
						const r = parseMentoring(doc);
						return { mentors: r.mentors, joined: [...r.joined] };
					})()
				: { mentors: [], joined: [] },
	});

	// ---- evaluations: best-effort, and mostly empty for a member
	const evaluations: EsEvaluation[] = [];
	try {
		total += 2;
		await page({
			key: "evaluations-page",
			url: get("my_evaluations.php"),
			label: "my evaluations",
			parse: () => null,
		});
		const list = parseEvaluationList(
			await page({
				key: "evaluations-list",
				url: get("api/v1/evaluations.php/my-evaluations"),
				label: "evaluation list",
				json: true,
				parse: (body) => JSON.parse(body) as unknown,
			}),
		);
		total += list.length;
		for (const item of list) {
			const detail = await page({
				key: `evaluation:${item.evaluation_id}`,
				url: get(`api/v1/evaluations.php/eval/${item.evaluation_id}`),
				label: `evaluation ${item.evaluation_id}`,
				json: true,
				parse: (body) => JSON.parse(body) as unknown,
			});
			evaluations.push(
				parseEvaluation(item, detail, clubPage.viewer.name ?? clubPage.viewer.username ?? ""),
			);
		}
	} catch (err) {
		evaluations.length = 0;
		progress(`evaluations skipped: ${(err as Error).message}`);
	}

	const input: AssembleInput = {
		exportedAt: new Date(now()).toISOString(),
		exportedBy: clubPage.viewer.username ?? "",
		club: {
			esClubId: clubPage.esClubId,
			number: clubPage.club.number,
			name: clubPage.club.name ?? "",
			timezone: tz,
		},
		people: memberPage.people.map((p) => ({ ...p, joined: null })),
		joined: new Map(mentoring.joined),
		meetings,
		speechRows,
		requestForms,
		mentors: mentoring.mentors,
		visitorsIntroduced,
		evaluations,
		raw,
	};
	const bundle = assembleBundle(input);
	await store.clear();
	return { bundle, fileName: bundleFileName(bundle) };
}

// ------------------------------------------------------------------ the real store

/**
 * IndexedDB, in the page's origin. `storage.local` has a 10MB quota and a club's
 * raw pages are bigger; `unlimitedStorage` would be a new permission, and the
 * export asks for exactly one (the host). The pages are the user's own data in
 * their own session, and the store is emptied when the export finishes.
 */
export function idbStore(dbName = "gavelup-easy-speak-export"): WalkStore {
	const open = () =>
		new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => req.result.createObjectStore("kv");
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	const run = async <T>(
		mode: IDBTransactionMode,
		fn: (s: IDBObjectStore) => IDBRequest<T>,
	): Promise<T> => {
		const db = await open();
		try {
			return await new Promise<T>((resolve, reject) => {
				const req = fn(db.transaction("kv", mode).objectStore("kv"));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
		} finally {
			db.close();
		}
	};
	return {
		get: (key) => run("readonly", (s) => s.get(key)),
		set: async (key, value) => {
			await run("readwrite", (s) => s.put(value, key));
		},
		clear: async () => {
			await run("readwrite", (s) => s.clear());
		},
	};
}

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
 *    own, usually none). Only a failed request, an error status or a page that
 *    is not signed in is forgiven there; a bug in a parser still aborts.
 *  - One walker per club store. A lease (owner id, expiry, renewed before every
 *    request) keeps a second tab from starting a second walk beside the first.
 *  - A stored export belongs to the club and Easy-Speak account that started it. The
 *    store is shared by every easy-speak.org tab, so a resume under a different club
 *    or account would mix the first one's pages into the second one's bundle; it
 *    discards the old export and starts fresh instead.
 */
import {
	type AssembleInput,
	type EasySpeakBundleV1,
	type EsEvaluation,
	type EsRawPage,
	type ParsedSpeechRow,
	type RequestFormInfo,
	assembleBundle,
	bundleFileName,
	isContactPage,
} from "./easy-speak-bundle";
import { EASY_SPEAK_ORIGIN } from "./easy-speak-hosts";
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
/** A reload within this long of the last page picks the walk up at once; older waits for the Resume button. */
export const AUTO_RESUME_WINDOW_MS = 2 * 60 * 1000;
/**
 * The lease is renewed before every request; a walker that goes quiet for this long
 * has lost it. A reload leaves the previous load's lease live for up to this long
 * (the new load has a new owner id), so it is also the longest a reload waits to
 * resume. Twenty seconds: a request that hangs longer than that lets the lease lapse,
 * which costs nothing but this walker stopping (it names the takeover) if a second
 * tab started meanwhile; pressing Resume carries on from the store.
 */
export const LEASE_TTL_MS = 20 * 1000;
/** A re-check after a lease runs out waits this long past its expiry, so it lands on the far side of it. */
export const LEASE_RECHECK_SLACK_MS = 250;
/**
 * The meeting list is walked year by year, newest first, down to this year, with
 * no early stop: a club can have a gap of years in its history, and stopping at
 * the first empty stretch would silently drop everything before it. Easy-Speak
 * offers no earliest-year picker to bound it (its start and end years are free
 * text inputs), so this is the floor.
 */
export const EARLIEST_MEETING_YEAR = 2004;

export interface WalkStore {
	get(key: string): Promise<unknown | undefined>;
	set(key: string, value: unknown): Promise<void>;
	/**
	 * Read, decide and write one key as a single step no other tab can slip into
	 * (one readwrite transaction in IndexedDB). `fn` returns the value to store, or
	 * `undefined` to leave the key as it is; the result is what the key holds after.
	 */
	update(
		key: string,
		fn: (current: unknown | undefined) => unknown | undefined,
	): Promise<unknown | undefined>;
	clear(): Promise<void>;
}

interface FetchResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

/** Who is exporting what: the Easy-Speak club and the signed-in account. */
export interface Identity {
	esClubId: string;
	username: string;
}

const sameIdentity = (a: Identity | undefined, b: Identity): boolean =>
	!!a && a.esClubId === b.esClubId && a.username === b.username;

/**
 * The identity a page shows: the club id every club page links and the viewer's
 * username. Null when either is missing (a popup, a login form).
 */
export function identityFromDoc(doc: Document): Identity | null {
	const esClubId = parseEsClubId(doc);
	const username = parseViewer(doc).username;
	return esClubId && username ? { esClubId, username } : null;
}

/**
 * The current identity, without trusting the store: from the page the user is on
 * when it shows both, else from a fresh `clubdata.php` request.
 */
export async function currentIdentity(
	liveDoc: Document,
	fetchImpl: WalkDeps["fetchImpl"],
	parseHtml: (html: string) => Document,
): Promise<Identity> {
	const live = identityFromDoc(liveDoc);
	if (live) return live;
	let body: string;
	try {
		const res = await fetchImpl(`${EASY_SPEAK_ORIGIN}/clubdata.php`, { credentials: "include" });
		if (!res.ok) throw new Error(`status ${res.status}`);
		body = await res.text();
	} catch (err) {
		throw new WalkError(`Could not read which club and account this is: ${(err as Error).message}`);
	}
	const fetched = identityFromDoc(parseHtml(body));
	if (!fetched) {
		throw new WalkError("Could not read which club and account this is. Sign in to Easy-Speak, then try again.");
	}
	return fetched;
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
	/** Identifies this walker in the lease. A fresh random id per page load. */
	owner: string;
	/** The club and account exporting now, read from the live page, never from the store. */
	identity: Identity;
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
	/** The club and account that started this export; another identity never resumes it. */
	identity: Identity;
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

/** A failure of the walk itself (a request, a status, a sign-in): it names the page and can be retried. */
class WalkError extends Error {}
/** Another walker holds, or took, the lease. Never a best-effort failure. */
class LeaseError extends Error {}

interface Lease {
	owner: string;
	expiresAt: number;
}
const LEASE = "lease";

/** A JSON endpoint that answers 200 with something else (a login page) is a not-signed-in failure. */
function parseJson(body: string, what: string): unknown {
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new WalkError(`${what} was not JSON. Sign in to Easy-Speak, then press Resume.`);
	}
}

const asLease = (v: unknown): Lease | undefined => v as Lease | undefined;

/** True when a different walker holds a lease that has not expired. */
function heldByOther(l: Lease | undefined, owner: string, now: number): boolean {
	return !!l && l.owner !== owner && l.expiresAt > now;
}

/** Take the lease, or renew ours. False when someone else's is still live. */
export async function acquireLease(
	store: WalkStore,
	owner: string,
	now: number,
): Promise<boolean> {
	const after = asLease(
		await store.update(LEASE, (cur) =>
			heldByOther(asLease(cur), owner, now)
				? undefined
				: ({ owner, expiresAt: now + LEASE_TTL_MS } satisfies Lease),
		),
	);
	return after?.owner === owner;
}

/** Give the lease up, if it is still ours. */
export async function releaseLease(store: WalkStore, owner: string): Promise<void> {
	await store.update(LEASE, (cur) =>
		asLease(cur)?.owner === owner ? ({ owner, expiresAt: 0 } satisfies Lease) : undefined,
	);
}

export type ResumeState =
	| { kind: "none" }
	/** An unfinished export from a reload moments ago: start it. */
	| { kind: "auto"; session: Session }
	/** An older unfinished export: wait for the Resume button. */
	| { kind: "manual"; session: Session }
	/** Another tab is walking right now. */
	| { kind: "elsewhere"; session: Session | null; leaseExpiresAt: number };

/**
 * What a freshly loaded page should do about an export in the store. A stored
 * export of another club or account is not this page's to resume: it counts as
 * none (the walk discards it).
 */
export async function resumeState(
	store: WalkStore,
	owner: string,
	now: number,
	identity: Identity,
): Promise<ResumeState> {
	const stored = await readSession(store, now);
	const session = stored && sameIdentity(stored.identity, identity) ? stored : null;
	const lease = asLease(await store.get(LEASE));
	if (lease && heldByOther(lease, owner, now)) {
		return { kind: "elsewhere", session, leaseExpiresAt: lease.expiresAt };
	}
	if (!session) return { kind: "none" };
	return now - session.lastActivityAt < AUTO_RESUME_WINDOW_MS
		? { kind: "auto", session }
		: { kind: "manual", session };
}

export interface FollowDeps {
	store: WalkStore;
	owner: string;
	identity: Identity;
	now: () => number;
	/** Test seam for `setTimeout`. */
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	onState: (state: ResumeState) => void;
}

/**
 * A reload leaves the previous load's lease live for up to LEASE_TTL_MS, and the
 * new load has a new owner id, so its first look says "elsewhere". Look again just
 * after that lease would run out; if it was renewed (a tab really is walking) look
 * again after the new expiry. Calls `onState` with every later state. Stops at the
 * first state that is not "elsewhere", or on `cancel`.
 */
export function followResume(initial: ResumeState, deps: FollowDeps): { cancel: () => void } {
	let handle: unknown;
	let cancelled = false;
	const arm = (state: ResumeState) => {
		if (cancelled || state.kind !== "elsewhere") return;
		const delay = Math.max(0, state.leaseExpiresAt - deps.now()) + LEASE_RECHECK_SLACK_MS;
		handle = deps.setTimer(async () => {
			if (cancelled) return;
			const next = await resumeState(deps.store, deps.owner, deps.now(), deps.identity);
			if (cancelled) return;
			deps.onState(next);
			arm(next);
		}, delay);
	};
	arm(initial);
	return {
		cancel: () => {
			cancelled = true;
			if (handle !== undefined) deps.clearTimer(handle);
		},
	};
}

export async function runExport(
	deps: WalkDeps,
): Promise<{ bundle: EasySpeakBundleV1; fileName: string }> {
	if (!(await acquireLease(deps.store, deps.owner, deps.now()))) {
		throw new LeaseError(
			"Another Easy-Speak tab is already running this export. Wait for it, or close it, then press Resume.",
		);
	}
	try {
		return await walk(deps);
	} finally {
		await releaseLease(deps.store, deps.owner);
	}
}

async function walk(
	deps: WalkDeps,
): Promise<{ bundle: EasySpeakBundleV1; fileName: string }> {
	const { store, now } = deps;
	const gap = deps.minGapMs ?? MIN_GAP_MS;

	const existing = await readSession(store, now());
	let session: Session;
	if (existing && sameIdentity(existing.identity, deps.identity)) {
		session = existing;
	} else {
		if (existing) {
			deps.onProgress?.({
				done: 0,
				total: 0,
				label: "Discarding an unfinished export of another club or Easy-Speak account; starting fresh.",
			});
		}
		await store.clear();
		// `clear` took the lease with everything else; nobody else can hold it, we just did.
		await acquireLease(store, deps.owner, now());
		session = { startedAt: now(), lastActivityAt: now(), pages: 0, identity: deps.identity };
		await store.set(META, session);
	}

	let lastStart = Number.NEGATIVE_INFINITY;
	let done = 0;
	let total = 0;
	const raw: EsRawPage[] = [];
	const progress = (label: string) => deps.onProgress?.({ done, total, label });

	/**
	 * Fetch (or read back) one page, parse it, and store it. `contact` pages keep
	 * only the parsed value. `parse` runs BEFORE the page is stored: a page it
	 * rejects (it throws a WalkError) is never cached, so Resume asks for it again
	 * instead of failing on the same bad copy forever.
	 */
	async function page<T>(spec: {
		key: string;
		url: string;
		init?: RequestInit;
		label: string;
		/** Shown in `raw` instead of `url`, for a POST whose parameters are not in the URL. */
		rawUrl?: string;
		json?: boolean;
		/** False drops the page from `raw` (an empty year's list says nothing a reader could use). */
		keepRaw?: (value: T) => boolean;
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
			// The heartbeat. It fails only if another tab's lease is live: ours lapsed
			// (a suspended tab) and they took over.
			if (!(await acquireLease(store, deps.owner, now()))) {
				throw new LeaseError("Another Easy-Speak tab took over this export.");
			}
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
		if (!contact && entry.body !== undefined && (spec.keepRaw?.(value) ?? true)) {
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
			const parsed = parseMemberList(doc);
			if (parsed.pages > 1) {
				throw new WalkError(
					`The member list has ${parsed.pages} pages; the export reads one. Ask for this to be added.`,
				);
			}
			return parsed;
		},
	});
	const tz = clubPage.club.timezone;

	// ---- every meeting: walk the list year by year, newest first, back to the first
	const meetingIds: string[] = [];
	const thisYear = new Date(now()).getUTCFullYear();
	for (let year = thisYear + 1; year >= EARLIEST_MEETING_YEAR; year--) {
		total += 1;
		const ids = await page<string[]>({
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
			keepRaw: (ids) => ids.length > 0,
			parse: (_b, doc) => (doc ? parseMeetingList(doc) : []),
		});
		for (const id of ids) if (!meetingIds.includes(id)) meetingIds.push(id);
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
			parse: (_b, doc) => {
				const parsed = doc ? parseMeeting(doc, id, tz) : null;
				if (!parsed) throw new WalkError(`Meeting ${id} is not a readable meeting page.`);
				return parsed;
			},
		});
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
				parse: (body) => parseJson(body, "evaluation data"),
			}),
		);
		total += list.length;
		for (const item of list) {
			const detail = await page({
				key: `evaluation:${item.evaluation_id}`,
				url: get(`api/v1/evaluations.php/eval/${item.evaluation_id}`),
				label: `evaluation ${item.evaluation_id}`,
				json: true,
				parse: (body) => parseJson(body, "evaluation data"),
			});
			evaluations.push(
				parseEvaluation(item, detail, clubPage.viewer.name ?? clubPage.viewer.username ?? ""),
			);
		}
	} catch (err) {
		// Only a failed request, an error status or a page that is not signed in is
		// forgiven here. A TypeError from a parser is a bug and must surface, not
		// become a quietly empty `evaluations`; a lost lease ends the walk.
		if (!(err instanceof WalkError)) throw err;
		evaluations.length = 0;
		progress(`evaluations skipped: ${err.message}`);
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
		update: async (key, fn) => {
			const db = await open();
			try {
				return await new Promise<unknown | undefined>((resolve, reject) => {
					const tx = db.transaction("kv", "readwrite");
					const os = tx.objectStore("kv");
					const get = os.get(key);
					let result: unknown;
					get.onsuccess = () => {
						const next = fn(get.result);
						if (next === undefined) {
							result = get.result;
						} else {
							result = next;
							os.put(next, key);
						}
					};
					tx.oncomplete = () => resolve(result);
					tx.onerror = () => reject(tx.error);
					tx.onabort = () => reject(tx.error);
				});
			} finally {
				db.close();
			}
		},
		clear: async () => {
			await run("readwrite", (s) => s.clear());
		},
	};
}

/**
 * What the Easy-Speak export remembers between runs (#1491): the month of the newest meeting
 * the last successful export held, per Easy-Speak club, so the next export can start there
 * instead of re-walking the whole history. Local to the browser; nothing here calls GavelUp.
 *
 * It lives in its own IndexedDB database because the walk's store is emptied after every export
 * (`runExport`), and it adds no permission. The decisions the widget makes (pre-fill, which month
 * a start uses, a changed club, what happens after the downloads) are pure functions here so they
 * are unit-tested; the DOM wiring itself is in `entrypoints/easyspeak.content.ts`.
 */
import type { EasySpeakBundleV3, EsMeeting } from "./easy-speak-bundle";

/** The first year Easy-Speak's meeting list can be asked for; the walk re-exports it (it lives here to avoid an import cycle). */
export const EARLIEST_MEETING_YEAR = 2004;

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;


/** `"05"` -> `"May"`. A fixed English list: no runtime locale. */
export function monthName(mm: string): string {
	return MONTH_NAMES[Number(mm) - 1] ?? mm;
}

/** `"2026-05"` -> `"May 2026"`. */
export function monthLabel(yyyyMm: string): string {
	const name = MONTH_NAMES[Number(yyyyMm.slice(5, 7)) - 1];
	return name ? `${name} ${yyyyMm.slice(0, 4)}` : yyyyMm;
}

/** True for a `yyyy-mm` whose year lies in `[minYear, maxYear]`. */
export function isWalkableMonth(value: string, minYear: number, maxYear: number): boolean {
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
	const year = Number(value.slice(0, 4));
	return year >= minYear && year <= maxYear;
}

// ------------------------------------------------------------------ newestHeldMonth

/** The widest real UTC offset: a wall time with no zone is at least this much earlier than any instant it could be. */
const WIDEST_OFFSET_MS = 14 * 60 * 60 * 1000;

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function utcMonth(iso: string): string {
	return new Date(iso).toISOString().slice(0, 7);
}

function zonedMonth(iso: string, timeZone: string | null): string {
	if (!timeZone) return utcMonth(iso);
	try {
		const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(
			new Date(iso),
		);
		const year = parts.find((p) => p.type === "year")?.value;
		const month = parts.find((p) => p.type === "month")?.value;
		return year && month ? `${year.padStart(4, "0")}-${month}` : utcMonth(iso);
	} catch {
		// An unknown zone: the UTC month, never the browser's.
		return utcMonth(iso);
	}
}

/** The club-local month a meeting had started in by `exportedAt`, or null when it had not (or cannot be read). */
function heldMonth(m: EsMeeting, exportedAtMs: number, timeZone: string | null): string | null {
	if (HAS_OFFSET.test(m.startsAt)) {
		const at = Date.parse(m.startsAt);
		if (Number.isNaN(at) || at > exportedAtMs) return null;
		return zonedMonth(m.startsAt, timeZone);
	}
	// Club-local wall time with no knowable instant: counted only when it is early enough to have
	// started whatever the zone, which can only pick an earlier month, never a later one.
	const wall = Date.parse(`${m.startsAt}Z`);
	if (Number.isNaN(wall) || wall > exportedAtMs - WIDEST_OFFSET_MS) return null;
	return m.startsAt.slice(0, 7);
}

/**
 * The club-local `yyyy-mm` of the newest meeting that had started by the bundle's `exportedAt`,
 * or null when none had. The walk also fetches upcoming meetings, so the literal newest is usually
 * in the future; remembering its month would skip the meetings held since.
 */
export function newestHeldMonth(
	bundle: Pick<EasySpeakBundleV3, "exportedAt" | "meetings"> & { club: Pick<EasySpeakBundleV3["club"], "timezone"> },
): string | null {
	const exportedAtMs = Date.parse(bundle.exportedAt);
	if (Number.isNaN(exportedAtMs)) return null;
	let newest: string | null = null;
	for (const m of bundle.meetings) {
		const month = heldMonth(m, exportedAtMs, bundle.club.timezone);
		// Months sort as strings, and a later meeting is never in an earlier month.
		if (month && (newest === null || month > newest)) newest = month;
	}
	return newest;
}

// ------------------------------------------------------------------ the remembered month

/** The two operations the remembered month needs; IndexedDB in the page, a map in a test. */
export interface KvStore {
	get(key: string): Promise<unknown | undefined>;
	set(key: string, value: unknown): Promise<void>;
}

const DB_NAME = "gavelup-easy-speak-last-export";
const clubKey = (esClubId: string) => `club:${esClubId}`;

/** IndexedDB, in the page's origin: database `gavelup-easy-speak-last-export`, store `kv`. */
export function idbKv(dbName = DB_NAME): KvStore {
	const open = () =>
		new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => req.result.createObjectStore("kv");
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
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
	};
}

export interface LastExportDeps {
	kv?: KvStore;
	/** Epoch milliseconds; bounds the accepted year at next year, as the walk does. */
	now?: () => number;
}

/**
 * The month this club's last successful export left off at, or null: nothing remembered, a read
 * that fails, a malformed value, or a month the walk would refuse.
 */
export async function readLastExport(esClubId: string, deps: LastExportDeps = {}): Promise<string | null> {
	try {
		const kv = deps.kv ?? idbKv();
		const value = (await kv.get(clubKey(esClubId))) as { month?: unknown } | undefined;
		const month = value?.month;
		if (typeof month !== "string") return null;
		const thisYear = new Date((deps.now ?? Date.now)()).getUTCFullYear();
		return isWalkableMonth(month, EARLIEST_MEETING_YEAR, thisYear + 1) ? month : null;
	} catch {
		return null;
	}
}

/** Remember `fromMonth` (`yyyy-mm`) for this club. Throws when the write fails; the caller decides what that means. */
export async function saveLastExport(esClubId: string, fromMonth: string, deps: LastExportDeps = {}): Promise<void> {
	const kv = deps.kv ?? idbKv();
	await kv.set(clubKey(esClubId), { month: fromMonth, savedAt: new Date((deps.now ?? Date.now)()).toISOString() });
}

// ------------------------------------------------------------------ the widget's decisions

export interface PickedMonth {
	/** `"yyyy"`, or `""` for all history. */
	year: string;
	/** `"01"`..`"12"`; meaningless while `year` is blank. */
	month: string;
}

const BLANK: PickedMonth = { year: "", month: "01" };

/** The selects' starting value: the club's remembered month, or blank when the page's club is unknown or none is remembered. */
export function prefill(identity: { esClubId: string } | null, remembered: string | null): PickedMonth {
	if (!identity || !remembered) return BLANK;
	return { year: remembered.slice(0, 4), month: remembered.slice(5, 7) };
}

/** The month a start walks from: a stored session's own (the selects are locked to it), else the selects'; null = full history. */
export function startMonth(session: { fromMonth?: string | null } | null, picked: PickedMonth): string | null {
	if (session) return session.fromMonth ?? null;
	return picked.year ? `${picked.year}-${picked.month}` : null;
}

/** True when the page was loaded for one club and Easy-Speak is now signed in to another. */
export function clubChanged(load: { esClubId: string } | null, fresh: { esClubId: string }): boolean {
	return load !== null && load.esClubId !== fresh.esClubId;
}

export const CLUB_CHANGED_MESSAGE =
	"This page was loaded for another club than the one Easy-Speak is signed in to now. Reload the page.";

export const SAVE_FAILED_MESSAGE = "Could not remember this export's month; pick it by hand next time.";

export interface ExportFiles {
	bundle: EasySpeakBundleV3;
	fileName: string;
	archive: unknown;
	archiveFileName: string;
}

export interface FinishIo {
	/** Saves one file; throws when it cannot. */
	download: (fileName: string, json: string) => void | Promise<void>;
	save: (esClubId: string, fromMonth: string) => Promise<void>;
}

/**
 * What follows a finished walk: the bundle download first (the file that matters lands even if
 * the browser blocks a second one), then the archive, and only when both returned, remember the
 * newest held month. A throwing download propagates and saves nothing; a throwing save is caught
 * and reported. Returns the status lines to append.
 */
export async function finishExport(result: ExportFiles, io: FinishIo): Promise<string[]> {
	await io.download(result.fileName, JSON.stringify(result.bundle));
	await io.download(result.archiveFileName, JSON.stringify(result.archive));
	const month = newestHeldMonth(result.bundle);
	if (month === null) return [];
	const lines = [`Next time, export from ${monthLabel(month)}.`];
	try {
		await io.save(result.bundle.club.esClubId, month);
	} catch {
		lines.push(SAVE_FAILED_MESSAGE);
	}
	return lines;
}

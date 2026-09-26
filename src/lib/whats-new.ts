/**
 * "What's new" (#947): the entries that tell users a feature exists, and the
 * rules for who sees which one and when it stops counting as new.
 *
 * Entries are content, not data. Each is a markdown file at
 * `content/whats-new/YYYY-MM-DD-<slug>.md` with a small front-matter block, and
 * the feature PR that ships a feature writes its own. They are bundled at build
 * time the same way `content/resources/*.md` is (`src/data/resource-content.ts`),
 * so there is no runtime filesystem access and this module is client-safe: it
 * imports nothing from `#/db` and holds no server state. Only the per-user SEEN
 * state lives in the database (`user.whats_new_seen_ids`, `user_feature_seen`);
 * a visitor without an account keeps theirs in `localStorage`, per club.
 *
 * NOTHING HERE IS SECRET. The eager glob below puts EVERY entry, admin-only ones
 * included, into the client bundle. Audience and `public` decide what is
 * RENDERED, not what is shipped, so nothing confidential belongs in
 * `content/whats-new/`.
 *
 * Nothing here sends anything to anyone. In-app and `/whats-new` only — product
 * email from GavelUp would be an exception to the human-sends rule (#899) and is
 * a separate decision.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Who an entry is written for. */
export const WHATS_NEW_AUDIENCES = ["admins", "members", "everyone"] as const;
export type WhatsNewAudience = (typeof WHATS_NEW_AUDIENCES)[number];

/**
 * The feature entry points that can carry a "New" badge. An entry may name one
 * as its `featureKey`; the guard test rejects any other value, so a typo cannot
 * ship an entry whose badge nothing will ever render. Add a key here in the
 * same PR that marks its entry point with `useIsNew(key)` / `<NewBadge>`.
 *
 * A nav destination whose key is listed here is badged in the sidebar
 * automatically (`app-shell.tsx`), so `account` needs no other wiring. The
 * guard test fails for a key that is neither a nav destination nor passed to
 * `useIsNew` anywhere in `src/` — a key nothing renders is a badge that can
 * never show.
 */
export const FEATURE_KEYS = ["account"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export function isFeatureKey(value: unknown): value is FeatureKey {
	return (
		typeof value === "string" &&
		(FEATURE_KEYS as readonly string[]).includes(value)
	);
}

/** How long a feature's badge (and the public-page banner) counts as new. */
export const NEW_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WhatsNewEntry {
	/** The filename without `.md`, e.g. `2026-09-26-promote`. Stable; it is what
	 *  a dismissal remembers. */
	id: string;
	title: string;
	/** `YYYY-MM-DD`, and equal to the filename's date prefix. */
	date: string;
	audience: WhatsNewAudience;
	/** Shown on the public `/whats-new` page. Admin-only features are false. */
	public: boolean;
	featureKey?: FeatureKey;
	/** An in-app path (`/…`) the entry's "Try it" goes to. */
	link?: string;
	/** 1–2 user-facing sentences, markdown. */
	body: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type ParseResult =
	| { ok: true; entry: WhatsNewEntry }
	| { ok: false; errors: string[] };

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_KEYS = new Set([
	"title",
	"date",
	"audience",
	"public",
	"featureKey",
	"link",
]);

function unquote(raw: string): string {
	const v = raw.trim();
	if (
		v.length >= 2 &&
		((v.startsWith('"') && v.endsWith('"')) ||
			(v.startsWith("'") && v.endsWith("'")))
	) {
		return v.slice(1, -1);
	}
	return v;
}

function isRealDate(date: string): boolean {
	if (!DATE_RE.test(date)) return false;
	const d = new Date(`${date}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** An in-app path: starts with one `/`, and is not protocol-relative (`//x`). */
function isInAppPath(link: string): boolean {
	return /^\/(?!\/)/.test(link) && !/\s/.test(link);
}

/**
 * Parse one entry file. `id` is the filename without `.md`. Deliberately strict:
 * every problem is reported (not just the first), unknown front-matter keys are
 * errors rather than silently ignored, and so is a filename date that disagrees
 * with `date:`.
 */
export function parseWhatsNewEntry(id: string, source: string): ParseResult {
	const errors: string[] = [];
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
	if (!match) {
		return {
			ok: false,
			errors: [`${id}: missing front-matter (a --- block at the top)`],
		};
	}
	const [, head, rawBody] = match;
	const fields: Record<string, string> = {};
	for (const line of head.split(/\r?\n/)) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
		if (!m) {
			errors.push(`${id}: unreadable front-matter line "${line}"`);
			continue;
		}
		const [, key, value] = m;
		if (!KNOWN_KEYS.has(key)) {
			errors.push(`${id}: unknown front-matter key "${key}"`);
			continue;
		}
		if (key in fields) errors.push(`${id}: "${key}" is set twice`);
		fields[key] = unquote(value);
	}

	const fileMatch = FILENAME_RE.exec(id);
	if (!fileMatch) {
		errors.push(`${id}: filename must be YYYY-MM-DD-<kebab-slug>.md`);
	}

	const title = fields.title ?? "";
	if (!title) errors.push(`${id}: "title" is required`);

	const date = fields.date ?? "";
	if (!isRealDate(date)) {
		errors.push(`${id}: "date" must be a real YYYY-MM-DD date`);
	} else if (fileMatch && fileMatch[1] !== date) {
		errors.push(
			`${id}: "date" (${date}) must match the filename's date (${fileMatch[1]})`,
		);
	}

	const audience = fields.audience;
	if (!(WHATS_NEW_AUDIENCES as readonly string[]).includes(audience ?? "")) {
		errors.push(
			`${id}: "audience" must be one of ${WHATS_NEW_AUDIENCES.join(", ")}`,
		);
	}

	const pub = fields.public;
	if (pub !== "true" && pub !== "false") {
		errors.push(`${id}: "public" must be true or false`);
	} else if (pub === "true" && audience === "admins") {
		// An admin-only feature is never advertised on the public page (#947
		// decision 1). Refused at the source, so no filter downstream has to be
		// the only thing standing between an officer tool and a stranger.
		errors.push(`${id}: an "admins" entry must be public: false`);
	}

	const featureKey = fields.featureKey;
	if (featureKey !== undefined && !isFeatureKey(featureKey)) {
		errors.push(
			`${id}: unknown featureKey "${featureKey}" (known: ${FEATURE_KEYS.join(", ")})`,
		);
	}

	const link = fields.link;
	if (link !== undefined && !isInAppPath(link)) {
		errors.push(`${id}: "link" must be an in-app path starting with /`);
	}

	const body = rawBody.trim();
	if (!body) errors.push(`${id}: the body is empty`);

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		entry: {
			id,
			title,
			date,
			audience: audience as WhatsNewAudience,
			public: pub === "true",
			...(featureKey ? { featureKey: featureKey as FeatureKey } : {}),
			...(link ? { link } : {}),
			body,
		},
	};
}

/** Newest first; ties broken by id so the order is total and stable. */
function byNewest(a: WhatsNewEntry, b: WhatsNewEntry): number {
	if (a.date !== b.date) return a.date < b.date ? 1 : -1;
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Parse a glob's worth of files (`{ "/content/whats-new/<id>.md": source }`).
 * An invalid file is left out and reported rather than thrown: a bad entry must
 * not take the app shell down in production. The guard test is what refuses to
 * let one ship.
 */
export function loadWhatsNewEntries(files: Record<string, string>): {
	entries: WhatsNewEntry[];
	errors: string[];
} {
	const entries: WhatsNewEntry[] = [];
	const errors: string[] = [];
	for (const [path, source] of Object.entries(files)) {
		const id = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
		const result = parseWhatsNewEntry(id, source);
		if (result.ok) entries.push(result.entry);
		else errors.push(...result.errors);
	}
	entries.sort(byNewest);
	return { entries, errors };
}

const files = import.meta.glob("/content/whats-new/*.md", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const loaded = loadWhatsNewEntries(files);

/** Every valid shipped entry, newest first. */
export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = loaded.entries;
/** Problems with shipped entries; empty on main (the guard test holds that). */
export const WHATS_NEW_LOAD_ERRORS: readonly string[] = loaded.errors;

// ---------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------

/** The instant an entry counts from: midnight UTC on its date. */
export function entryTime(entry: Pick<WhatsNewEntry, "date">): number {
	return Date.parse(`${entry.date}T00:00:00Z`);
}

/** Not dated in the future: an entry merged ahead of its date waits for it. */
export function isPublished(entry: WhatsNewEntry, now: Date): boolean {
	return entryTime(entry) <= now.getTime();
}

/**
 * The entries a signed-in viewer is eligible for, as of `now`. An admin or
 * officer of the current club sees `admins` and `everyone`; anyone else sees
 * `members` and `everyone`. An entry dated after `now` is nobody's yet.
 */
export function eligibleEntries(
	entries: readonly WhatsNewEntry[],
	viewer: { isAdmin: boolean; now: Date },
): WhatsNewEntry[] {
	return entries
		.filter((e) => isPublished(e, viewer.now))
		.filter((e) =>
			e.audience === "everyone"
				? true
				: e.audience === "admins"
					? viewer.isAdmin
					: !viewer.isAdmin,
		)
		.sort(byNewest);
}

/** The `/whats-new` page: `public: true` only, newest first. */
export function publicEntries(
	entries: readonly WhatsNewEntry[],
	now: Date,
): WhatsNewEntry[] {
	return entries.filter((e) => e.public && isPublished(e, now)).sort(byNewest);
}

/**
 * Whether the header dot shows: some eligible entry is not among the ids the
 * user has seen. By id, never by comparing an entry's date to when the panel
 * was opened — the date is the day the entry was WRITTEN, so an entry dated
 * today that merges after this morning's open, or one dated Monday that merges
 * Wednesday, would sort before the open and never light the dot. `seenIds`
 * null means the state could not be read: no dot (fail silent).
 */
export function hasUnseenEntries(
	eligible: readonly WhatsNewEntry[],
	seenIds: ReadonlySet<string> | null,
): boolean {
	if (seenIds === null) return false;
	return eligible.some((e) => !seenIds.has(e.id));
}

/** Every shipped entry id; the server keeps only these when marking seen. */
export function isWhatsNewEntryId(id: string): boolean {
	return WHATS_NEW_ENTRIES.some((e) => e.id === id);
}

/** Within `NEW_WINDOW_DAYS` of its date (and not dated in the future). */
export function isWithinNewWindow(entry: WhatsNewEntry, now: Date): boolean {
	const age = now.getTime() - entryTime(entry);
	return age >= 0 && age < NEW_WINDOW_DAYS * DAY_MS;
}

/**
 * Whether a feature's entry point should wear a "New" badge: some eligible entry
 * names it, that entry is still inside the window, and the viewer has not used
 * or dismissed it. `seen` is null when the seen-state could not be read (storage
 * blocked, request failed), and that means NOT new: a failure shows nothing,
 * never a badge that cannot be cleared.
 */
export function isFeatureNew(args: {
	eligible: readonly WhatsNewEntry[];
	featureKey: string;
	seen: ReadonlySet<string> | null;
	now: Date;
}): boolean {
	if (args.seen === null || args.seen.has(args.featureKey)) return false;
	return args.eligible.some(
		(e) => e.featureKey === args.featureKey && isWithinNewWindow(e, args.now),
	);
}

/**
 * The one banner a club member without an account sees on the public club and
 * meeting pages: the newest `public` entry aimed at `members` or `everyone`,
 * still inside the window, that they have not dismissed. `dismissed` null means
 * storage is unavailable, which shows nothing.
 */
export function bannerEntry(args: {
	entries: readonly WhatsNewEntry[];
	dismissed: ReadonlySet<string> | null;
	now: Date;
}): WhatsNewEntry | null {
	if (args.dismissed === null) return null;
	const dismissed = args.dismissed;
	return (
		publicEntries(args.entries, args.now).find(
			(e) =>
				e.audience !== "admins" &&
				isWithinNewWindow(e, args.now) &&
				!dismissed.has(e.id),
		) ?? null
	);
}

// ---------------------------------------------------------------------------
// Browser storage for visitors without an account
// ---------------------------------------------------------------------------

export const dismissedBannerKey = (clubId: string) =>
	`gavelup:whats-new:dismissed:${clubId}`;
export const featureSeenKey = (clubId: string) =>
	`gavelup:whats-new:features:${clubId}`;

/**
 * Read a stored string set. Returns null when storage is unavailable or throws
 * (private window, sandboxed iframe, SSR) so the caller can show nothing; a
 * missing or malformed value is an empty set, which is a normal first visit.
 */
export function readStoredSet(key: string): Set<string> | null {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(key);
		if (!raw) return new Set();
		return parseStringSet(raw);
	} catch {
		return null;
	}
}

/** Garbage in the key is an empty set, not "unavailable": treating it as
 *  unavailable would also refuse every later write, so a corrupted value
 *  could never be repaired. */
function parseStringSet(raw: string): Set<string> {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? new Set(parsed.filter((v): v is string => typeof v === "string"))
			: new Set();
	} catch {
		return new Set();
	}
}

/** Add a value to a stored set. Silent on failure: the page still works, the
 *  choice just is not remembered. */
export function addToStoredSet(key: string, value: string): void {
	try {
		const current = readStoredSet(key);
		if (current === null) return;
		current.add(value);
		localStorage.setItem(key, JSON.stringify([...current]));
	} catch {
		// Storage full or blocked — nothing to do.
	}
}

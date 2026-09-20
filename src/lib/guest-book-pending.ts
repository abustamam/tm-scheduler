/**
 * The guest-book confirm page's PURE half (#806).
 *
 * `record_guest_book` no longer applies anything. It previews, stores what was
 * transcribed as a pending plan, and hands back a link; a human opens that link
 * signed in, sees the real values, fixes what the transcription got wrong, and
 * applies. This module holds the parts of that flow with no database and no
 * request in them, so the route and the server both read one implementation:
 * the stored entry shape, the expiry/grace arithmetic, the editing reducer, and
 * the index map that makes dropping a line safe.
 *
 * ## Why a stable `id` per entry
 *
 * `plan()` numbers entries POSITIONALLY — `args.entries.map((raw, index) => …)`
 * — and reads answers to ambiguous lines as `resolve[String(index)]`. So the
 * planner's index space is the space of the lines it was HANDED, and dropping a
 * line renumbers every line after it. Two index spaces therefore exist and must
 * never be assumed equal:
 *
 *   - the STORED list, which keeps dropped rows so a drop survives a reload and
 *     can be undone;
 *   - the PLANNED list, which is `livePendingEntries()` of it.
 *
 * Everything the page holds onto is keyed by `PendingEntry.id`; everything the
 * planner says is keyed by position in the planned list. `pendingPlanArgs`
 * converts one way and `entryIdForBlockingIndex` converts back. Nothing else
 * may cross the seam.
 *
 * Client-safe on purpose: the confirm route imports this, so it must pull in no
 * `node:` builtin and no database module. That is why `guestBookConfirmUrl`
 * takes the origin as an argument rather than reading `BETTER_AUTH_URL` here —
 * the server passes `appBaseUrl()`, whose fallback stays declared in exactly one
 * place (`src/lib/unsubscribe-token.ts`).
 */

/** A line resolves onto a guest already on file, or declares a new person. */
export type PendingEntryResolve =
	| { kind: "existing"; guestId: string }
	| { kind: "new" };

/**
 * One transcribed line, as stored on the pending row.
 *
 * Optional fields are ABSENT rather than null when empty: this shape is
 * round-tripped through `jsonb`, and `canonicalize` (the plan hash) drops
 * `undefined` and keeps `null`, so letting both spellings exist would make two
 * identical pages hash differently depending on how they were edited.
 */
export interface PendingEntry {
	/** Stable for the life of the pending row. Minted at preview. */
	id: string;
	name: string;
	preferredName?: string;
	email?: string;
	phone?: string;
	/** Kept in the stored list, excluded from the planned one. */
	dropped?: boolean;
	/** The answer to an `AMBIGUOUS_GUEST` item, carried per entry (see header). */
	resolve?: PendingEntryResolve;
}

/** A pending plan is openable for a day. */
export const PENDING_PLAN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * And survives, unopenable, for a day after that.
 *
 * The grace window is what keeps AC11 and AC12 from racing: a plan that has
 * just expired renders an "expired" state — which is an explanation — rather
 * than vanishing into "never existed", which reads like a bug. The sweep only
 * removes rows past BOTH windows.
 */
export const PENDING_PLAN_GRACE_MS = 24 * 60 * 60 * 1000;

export function pendingPlanExpiresAt(createdAt: Date): Date {
	return new Date(createdAt.getTime() + PENDING_PLAN_TTL_MS);
}

/** Past its window: readable as "expired", not appliable. */
export function isPendingPlanExpired(
	row: { expiresAt: Date },
	now: Date = new Date(),
): boolean {
	return row.expiresAt.getTime() <= now.getTime();
}

/**
 * The instant the sweep deletes below: rows whose `expires_at` is older than
 * this are past BOTH windows and go, applied or not.
 *
 * One arithmetic, read by the SQL predicate the poller runs and by the test
 * that pins the boundary, so "expired" and "swept" cannot drift into a gap
 * where a row is gone while the page still promises an explanation.
 */
export function pendingPlanSweepCutoff(now: Date = new Date()): Date {
	return new Date(now.getTime() - PENDING_PLAN_GRACE_MS);
}

/** The lines the planner is handed: stored order, dropped rows removed. */
export function livePendingEntries(entries: PendingEntry[]): PendingEntry[] {
	return entries.filter((e) => !e.dropped);
}

/** What one live entry looks like to `plan()`. Positional; see the header. */
export interface PendingPlanArgs {
	entries: {
		name: string;
		preferredName?: string;
		email?: string;
		phone?: string;
	}[];
	resolve: Record<string, string>;
}

/**
 * Convert the stored list into the planner's positional arguments.
 *
 * `resolve` is assembled HERE, from each live entry's own `resolve` field, so
 * the per-entry answer and the positional map never have to agree with each
 * other — the map is derived from the answers on every call.
 */
export function pendingPlanArgs(entries: PendingEntry[]): PendingPlanArgs {
	const live = livePendingEntries(entries);
	const resolve: Record<string, string> = {};
	live.forEach((entry, index) => {
		if (!entry.resolve) return;
		resolve[String(index)] =
			entry.resolve.kind === "new" ? "new" : entry.resolve.guestId;
	});
	return {
		entries: live.map((e) => ({
			name: e.name,
			...(e.preferredName ? { preferredName: e.preferredName } : {}),
			...(e.email ? { email: e.email } : {}),
			...(e.phone ? { phone: e.phone } : {}),
		})),
		resolve,
	};
}

/**
 * The stored entry a planner-side `entryIndex` belongs to.
 *
 * Null when the index names no live line (a blocking item that belongs to the
 * CALL rather than a line carries no index at all, and a stale index from a
 * previous render must not be attached to whichever row now sits there).
 */
export function entryIdForBlockingIndex(
	entries: PendingEntry[],
	entryIndex: number | undefined,
): string | null {
	if (entryIndex === undefined) return null;
	return livePendingEntries(entries)[entryIndex]?.id ?? null;
}

/** The transcribed fields a human may correct on the confirm page. */
export type PendingEntryField = "name" | "preferredName" | "email" | "phone";

export type PendingEntryEdit =
	| { kind: "field"; id: string; field: PendingEntryField; value: string }
	/** `null` puts an answered line back to ambiguous. */
	| { kind: "resolve"; id: string; resolve: PendingEntryResolve | null }
	| { kind: "dropped"; id: string; dropped: boolean };

/**
 * Apply one edit, returning a NEW list.
 *
 * An emptied optional field is DELETED rather than set to `""` — see
 * `PendingEntry` for why the two spellings must not both exist. `name` is the
 * one field with no empty form: the server fn's validator rejects a blank one
 * before it reaches here, because a guest row with an empty name is a write
 * nothing downstream can undo.
 */
export function applyPendingEntryEdit(
	entries: PendingEntry[],
	edit: PendingEntryEdit,
): PendingEntry[] {
	return entries.map((entry) => {
		if (entry.id !== edit.id) return entry;
		if (edit.kind === "dropped") {
			const next = { ...entry };
			if (edit.dropped) next.dropped = true;
			else delete next.dropped;
			return next;
		}
		if (edit.kind === "resolve") {
			const next = { ...entry };
			if (edit.resolve) next.resolve = edit.resolve;
			else delete next.resolve;
			return next;
		}
		const value = edit.value.trim();
		const next = { ...entry };
		if (edit.field === "name") {
			next.name = value;
			return next;
		}
		if (value) next[edit.field] = value;
		else delete next[edit.field];
		return next;
	});
}

/** Where the confirm page lives. One spelling, shared by the link and the route. */
export function guestBookConfirmPath(pendingId: string): string {
	return `/guest-book/${pendingId}`;
}

/**
 * The absolute link a preview hands back.
 *
 * ABSOLUTE, not relative: the caller is an LLM in someone else's client, and a
 * path alone is not something a person can open. `origin` comes from the
 * server (`appBaseUrl()`), which is where the `BETTER_AUTH_URL` fallback is
 * declared — this module stays free of `process.env` so the route can import it.
 */
export function guestBookConfirmUrl(origin: string, pendingId: string): string {
	return `${origin.replace(/\/+$/, "")}${guestBookConfirmPath(pendingId)}`;
}

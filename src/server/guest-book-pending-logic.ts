/**
 * Every decision the guest-book confirm page makes (#806).
 *
 * `createServerFn` handler bodies cannot be executed from vitest — they need
 * the Start runtime — so a decision written inside one is a decision no test in
 * this repo can reach. (`club-logo-method.guard.test.ts` is the standing
 * precedent: a transport property invisible to the whole suite.) So the
 * wrappers in `guest-book-pending.ts` resolve the session and delegate, and
 * everything that DECIDES lives here, where an integration test can call it
 * directly.
 *
 * ## What is here, and what is one module over (#812)
 *
 * The LIFECYCLE is shared with every other MCP write tool and lives in
 * `src/server/mcp-pending-logic.ts`: the four ordered resolution checks
 * (exists-and-is-this-tool's, creator-only, the archive gate, still-an-admin),
 * and the sweep. `src/server/mcp-pending-apply.ts` owns the locked claim, and
 * `src/lib/pending-plan.ts` owns the expiry arithmetic. None of that is
 * guest-book knowledge, and two copies of a retention-and-authorization
 * lifecycle is how one copy gets a fix and the other does not — this one holds
 * visitor names, emails and phone numbers.
 *
 * What stays here is what only this tool can say about its own payload:
 *
 *   - reading `{ meetingDate, entries }` out of the shared `payload` column,
 *   - re-planning it and projecting the page,
 *   - mapping an `McpError` out of `plan()` onto a page state, so no MCP error
 *     ever reaches a route error boundary,
 *   - and the edit path, whose `applied_at IS NULL` predicate is what stops an
 *     in-flight PATCH writing contact details back over a tombstone.
 *
 * The WRITE is delegated to `guest-book-apply.ts`, which fills in the shared
 * locked skeleton with this tool's re-plan, hash comparison and inserts.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { mcpPendingPlans } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	ALREADY_RECORDED_MESSAGE,
	applyPendingEntryEdit,
	EXPIRED_MESSAGE,
	entryIdForBlockingIndex,
	isPendingPlanExpired,
	livePendingEntries,
	type PendingEntry,
	type PendingEntryEdit,
	pendingPlanArgs,
} from "#/lib/guest-book-pending";
import { loadClubDefaultCountryCode } from "#/server/clubs-logic";
import { NO_PERMISSION_MESSAGE, NOT_A_MEMBER_MESSAGE } from "#/server/guards";
import {
	type ApplyGuestBookPlanResult,
	applyGuestBookPlan,
} from "#/server/guest-book-apply";
import {
	parseGuestBookPayload,
	UNREADABLE_ENTRIES_MESSAGE,
} from "#/server/guest-book-pending-schemas";
import {
	type AmbiguousGuestDetail,
	type GuestBookCandidate,
	type GuestBookOutcome,
	guestBookPlanHash,
	plan,
	planSummary,
} from "#/server/guest-book-plan";
import { type McpBlockingCode, McpError } from "#/server/mcp/errors";
import {
	PENDING_ARCHIVED,
	PENDING_NOT_FOUND,
	type PendingPlanRow,
	resolvePending,
} from "#/server/mcp-pending-logic";

/** The tool every read and write in this module names. See `resolvePending`. */
export const GUEST_BOOK_TOOL = "record_guest_book" as const;

/**
 * A blocking item as the confirm page needs it: keyed to the STORED entry, not
 * to a planner index, and with a CONCRETE detail type.
 *
 * Built explicitly rather than by extending `McpBlockingItem`, whose `detail`
 * is `unknown`. Two reasons, and the second is the one that bites: a server fn
 * return crosses a serialization boundary that refuses `unknown`, and the page
 * should be able to render an ambiguity's candidates without casting its way
 * into them.
 */
export interface ConfirmBlockingItem {
	code: McpBlockingCode;
	message: string;
	/**
	 * Null when the item belongs to the call rather than a line (there is no
	 * meeting on that date), and null when the index names no live line.
	 * Dropping a line renumbers the planner's indices, so this mapping is
	 * re-derived on every render — see `src/lib/guest-book-pending.ts`.
	 */
	entryId: string | null;
	/**
	 * The guests this line might be, UNMASKED, for an `AMBIGUOUS_GUEST` item;
	 * empty for every other code. Unmasked because an email is routinely the
	 * only thing telling two guests with one name apart, which is the question
	 * the item is asking — see `guest-book-plan.ts`'s header.
	 */
	candidates: GuestBookCandidate[];
}

/** What the plan says about one STORED line, keyed by the id the page holds. */
export interface ConfirmLine {
	entryId: string;
	/** Null for a dropped line: the planner was never handed it. */
	outcome: GuestBookOutcome | null;
	guestId: string | null;
	via: "email" | "phone" | "resolved" | null;
	/** The existing guest's name, when it differs from what is written down. */
	matchedName: string | null;
	minutesRecipient: boolean;
}

export interface PendingPlanHeader {
	pendingId: string;
	clubId: string;
	clubName: string;
	/**
	 * Club-local, read out of the payload rather than off a column since #812.
	 *
	 * Null ONLY when the payload's envelope did not parse — a release this one
	 * has never seen wrote the row, so there is no date to name. Every other
	 * state has one, the applied tombstone included: its page still says which
	 * meeting the visitors ended up on, so apply keeps the date and drops the
	 * transcription.
	 */
	meetingDate: string | null;
	/** ISO, for rendering. */
	expiresAt: string;
}

/**
 * What the route renders. A discriminated union rather than a bag of nullable
 * fields, so a page state that carries no visitor data cannot accidentally be
 * rendered with some (AC10's applied tombstone is the case that matters).
 */
export type PendingPlanView =
	/** Unknown id, a different user's plan, or a creator who is no longer an admin. */
	| { status: "not_found" }
	| { status: "archived"; message: string }
	| ({ status: "expired" } & PendingPlanHeader)
	| ({ status: "applied"; appliedAt: string } & PendingPlanHeader)
	/**
	 * The date names no meeting, names two, or names one that has not happened
	 * yet. There is nothing to approve — only the reason to answer.
	 */
	| ({
			status: "unplannable";
			reason: string;
			message: string;
			entries: PendingEntry[];
	  } & PendingPlanHeader)
	| ({
			status: "editable";
			entries: PendingEntry[];
			meeting: { meetingId: string; date: string; theme: string | null };
			meetingNumber: number | null;
			summary: ReturnType<typeof planSummary>;
			lines: ConfirmLine[];
			blocking: ConfirmBlockingItem[];
			planHash: string;
	  } & PendingPlanHeader);

/**
 * A pending row, joined to its club and with this tool's payload parsed out.
 *
 * The lifecycle fields come from `PendingPlanRow`; the two below are what
 * `parseGuestBookPayload` made of the shared `payload` column.
 */
interface GuestBookPendingRow extends PendingPlanRow {
	/**
	 * Club-local, as the caller named it, read out of the payload.
	 *
	 * Null ONLY when not even the payload's envelope is readable — a release
	 * this one has never seen wrote the row. Every other state has a date,
	 * including the applied tombstone, whose page still says which meeting the
	 * visitors are on.
	 */
	meetingDate: string | null;
	entries: PendingEntry[] | null;
	/**
	 * The payload held something this release cannot parse.
	 *
	 * Distinct from `entries: null`, which is the applied tombstone and means
	 * "there is deliberately nothing here". See `parseGuestBookPayload`.
	 */
	entriesUnreadable: boolean;
}

const NOT_FOUND: PendingPlanView = { ...PENDING_NOT_FOUND };
const ARCHIVED: PendingPlanView = { ...PENDING_ARCHIVED };

function headerOf(row: GuestBookPendingRow): PendingPlanHeader {
	return {
		pendingId: row.id,
		clubId: row.clubId,
		clubName: row.clubName,
		meetingDate: row.meetingDate,
		expiresAt: row.expiresAt.toISOString(),
	};
}

/** Read this tool's payload off a row the lifecycle has already resolved. */
function withPayload(row: PendingPlanRow): GuestBookPendingRow {
	// PARSE, do not trust the column's compile-time type. See
	// `parseGuestBookPayload` for the deploy boundary this closes.
	const payload = parseGuestBookPayload(row.payload);
	if (!payload) {
		return {
			...row,
			meetingDate: null,
			entries: null,
			entriesUnreadable: true,
		};
	}
	return {
		...row,
		meetingDate: payload.meetingDate,
		entries: payload.entries,
		entriesUnreadable: payload.entriesUnreadable,
	};
}

/**
 * Re-read one row, for the places that need to see what is stored NOW after a
 * write they did not fully control.
 *
 * Through `resolvePending` rather than a second SELECT of its own: the four
 * ordered checks have exactly one definition, and a private re-read here would
 * be a second read path whose WHERE could forget the tool discriminator. Every
 * caller already holds the user id it was resolved with a moment earlier, so the
 * repeat is three cheap queries on a path that has just re-planned.
 */
async function reread(
	pendingId: string,
	userId: string,
): Promise<GuestBookPendingRow | null> {
	const resolved = await resolvePending(pendingId, userId, GUEST_BOOK_TOOL);
	return resolved.ok ? withPayload(resolved.row) : null;
}

/**
 * Re-plan and project. Called on load, after every edit, and after a refused
 * apply — one mapping, so the three can never render different things about
 * the same row.
 */
async function renderPendingPlan(
	row: GuestBookPendingRow,
): Promise<PendingPlanView> {
	const header = headerOf(row);
	if (row.appliedAt) {
		return {
			...header,
			status: "applied",
			appliedAt: row.appliedAt.toISOString(),
		};
	}
	if (isPendingPlanExpired(row)) return { ...header, status: "expired" };
	// `meetingDate === null` means the payload's envelope did not parse, which is
	// the same answer as an unreadable transcription: a release this one has never
	// seen wrote the row. Checked together so the plan below can take a date that
	// is definitely a string.
	if (row.entriesUnreadable || row.meetingDate === null) {
		return {
			...header,
			status: "unplannable",
			reason: "UNREADABLE",
			message: UNREADABLE_ENTRIES_MESSAGE,
			entries: [],
		};
	}
	const meetingDate = row.meetingDate;

	const entries = row.entries ?? [];
	const club = { clubId: row.clubId, timezone: row.timezone };
	const countryCode = await loadClubDefaultCountryCode(row.clubId);

	let planned: Awaited<ReturnType<typeof plan>>;
	try {
		planned = await plan(
			db,
			club,
			{ meetingDate, ...pendingPlanArgs(entries) },
			countryCode,
		);
	} catch (err) {
		// `plan()` throws `McpError` for a meeting that has not happened yet, and
		// this page re-plans through the same function — so the error has to become
		// a page STATE here. Letting one escape would surface as a route error
		// boundary on a URL whose whole job is to explain what is wrong (AC16).
		// Anything that is not an `McpError` is a real failure and is rethrown.
		//
		// There is deliberately no `ARCHIVED` arm here. `resolvePending` calls
		// the archive gate before `plan()` is ever reached, so an archived club
		// has already rendered `ARCHIVED` and cannot arrive; `NOT_RECORDABLE` is
		// in fact `plan()`'s only throw today. An arm no caller can produce is
		// the same drift `blocking-codes.guard.test.ts` was built to remove.
		if (err instanceof McpError) {
			return {
				...header,
				status: "unplannable",
				reason: err.code,
				message: err.message,
				entries,
			};
		}
		throw err;
	}

	if (!planned.plan) {
		const first = planned.blocking[0];
		return {
			...header,
			status: "unplannable",
			reason: first?.code ?? "BLOCKED",
			message:
				first?.message ??
				"That date does not name one meeting of this club any more.",
			entries,
		};
	}

	const live = livePendingEntries(entries);
	const byEntryId = new Map(
		planned.plan.entries.map((e) => [live[e.index]?.id ?? "", e]),
	);

	return {
		...header,
		status: "editable",
		entries,
		meeting: planned.plan.meeting,
		meetingNumber: planned.meetingNumber,
		summary: planSummary(planned.plan),
		lines: entries.map((entry): ConfirmLine => {
			const p = byEntryId.get(entry.id);
			return {
				entryId: entry.id,
				outcome: p?.outcome ?? null,
				guestId: p?.guestId ?? null,
				via: p?.via ?? null,
				matchedName: p?.matchedName ?? null,
				minutesRecipient: p?.minutesRecipient ?? false,
			};
		}),
		blocking: planned.blocking.map((item): ConfirmBlockingItem => {
			const detail =
				item.code === "AMBIGUOUS_GUEST"
					? (item.detail as AmbiguousGuestDetail | undefined)
					: undefined;
			return {
				code: item.code,
				message: item.message,
				entryId: entryIdForBlockingIndex(entries, item.entryIndex),
				candidates: detail?.candidates ?? [],
			};
		}),
		// UNMASKED values, hashed exactly as the MCP preview hashed them: the
		// creator is the hash's `userId` on both sides, so a plan previewed by
		// them and applied by them is the same function of the same inputs.
		planHash: guestBookPlanHash({
			clubId: row.clubId,
			userId: row.createdByUserId,
			plan: planned.plan,
		}),
	};
}

export async function loadPendingPlan(input: {
	pendingId: string;
	userId: string;
}): Promise<PendingPlanView> {
	const resolved = await resolvePending(
		input.pendingId,
		input.userId,
		GUEST_BOOK_TOOL,
	);
	if (!resolved.ok) return resolved.refusal;
	return renderPendingPlan(withPayload(resolved.row));
}

/**
 * Persist one edit and re-plan.
 *
 * Every PATCH returns a FRESH `planHash`, and that is not a nicety: the page
 * sends the hash it last rendered with Apply, and an edit changes the plan, so
 * without a new hash every apply after an edit would refuse as `PLAN_STALE`.
 */
export async function patchPendingPlan(input: {
	pendingId: string;
	userId: string;
	edit: PendingEntryEdit;
}): Promise<PendingPlanView> {
	const resolved = await resolvePending(
		input.pendingId,
		input.userId,
		GUEST_BOOK_TOOL,
	);
	if (!resolved.ok) return resolved.refusal;
	const row = withPayload(resolved.row);

	// An applied or expired plan is not editable. Re-rendering rather than
	// throwing keeps one mapping for the page: it gets the same view it would
	// have got from a fresh load.
	if (row.appliedAt || isPendingPlanExpired(row) || row.entriesUnreadable) {
		return renderPendingPlan(row);
	}

	const entries = applyPendingEntryEdit(row.entries ?? [], input.edit);
	// `applied_at IS NULL` in the WHERE, not just in the check above.
	//
	// The read that produced `row` is not locked, so an apply can commit between
	// it and this write — the reader has the page open in one tab and clicks
	// Record in another. An unconditional UPDATE would then put the visitor
	// names, emails and phones back into the row the apply had just nulled,
	// which is the whole point of the tombstone. The predicate makes the
	// check-then-write atomic; zero rows means the apply won the race.
	//
	// The WHOLE payload is rewritten, not a field inside it: `meetingDate` is
	// carried through from what was parsed, so an edit cannot drop it. The tool
	// is in the WHERE too, for the same reason every other read has it.
	const written = await db
		.update(mcpPendingPlans)
		.set({ payload: { meetingDate: row.meetingDate, entries } })
		.where(
			and(
				eq(mcpPendingPlans.id, input.pendingId),
				eq(mcpPendingPlans.tool, GUEST_BOOK_TOOL),
				isNull(mcpPendingPlans.appliedAt),
			),
		);
	if ((written.rowCount ?? 0) === 0) {
		// Re-read rather than render `row`: what is on screen has to be what is
		// stored, and what is stored is now the tombstone.
		const after = await reread(input.pendingId, input.userId);
		return after ? renderPendingPlan(after) : NOT_FOUND;
	}

	return renderPendingPlan({ ...row, entries });
}

export interface ApplyPendingResult {
	ok: boolean;
	/** One sentence for the person who clicked, when it refused. */
	message: string | null;
	/** What to render now — a fresh plan on a refusal, the tombstone on success. */
	view: PendingPlanView;
	/** Present only on success. */
	applied: ApplyGuestBookPlanResult | null;
}

/**
 * Apply, and turn every refusal into a page state.
 *
 * `guest-book-apply.ts` throws `McpError` so its transaction rolls back; the
 * route needs data, not an exception — an error crossing a `createServerFn`
 * boundary arrives as a bare message with no code on it. So the codes are
 * mapped here, once, and the caller always gets a view it can render.
 */
export async function applyPendingPlan(input: {
	pendingId: string;
	userId: string;
	planHash: string;
}): Promise<ApplyPendingResult> {
	const resolved = await resolvePending(
		input.pendingId,
		input.userId,
		GUEST_BOOK_TOOL,
	);
	if (!resolved.ok) {
		return { ok: false, message: null, view: resolved.refusal, applied: null };
	}
	const { actorMemberId } = resolved;
	const row = withPayload(resolved.row);

	const unreadable = row.entriesUnreadable || row.meetingDate === null;
	if (row.appliedAt || isPendingPlanExpired(row) || unreadable) {
		return {
			ok: false,
			// The CHEAP, unlocked pre-check's sentence. It is deliberately not the
			// one the locked guard gives — see `RECORDED_WHILE_OPEN_MESSAGE`.
			message: row.appliedAt
				? ALREADY_RECORDED_MESSAGE
				: unreadable
					? UNREADABLE_ENTRIES_MESSAGE
					: EXPIRED_MESSAGE,
			view: await renderPendingPlan(row),
			applied: null,
		};
	}

	try {
		const applied = await applyGuestBookPlan({
			pendingId: row.id,
			club: { clubId: row.clubId, timezone: row.timezone },
			userId: input.userId,
			actorMemberId,
			planHash: input.planHash,
			countryCode: await loadClubDefaultCountryCode(row.clubId),
		});
		// Re-read: the row is a tombstone now, and the applied view is built from
		// what is actually stored rather than from what this function assumed.
		const after = await reread(input.pendingId, input.userId);
		return {
			ok: true,
			message: null,
			view: after ? await renderPendingPlan(after) : NOT_FOUND,
			applied,
		};
	} catch (err) {
		// The in-transaction re-check (`assertStillClubAdmin`) throws plain
		// `Error`s carrying the guards' own exported sentences, because it IS
		// `requireClubRole` asked again against `tx`. Map them to the same page
		// states the up-front check produces, so a grant pulled during the lock
		// wait renders exactly what a grant pulled a second earlier renders.
		//
		// Compared by IDENTITY with the exported constants, never by substring —
		// the one sanctioned exception `src/server/mcp/errors.ts` names, and the
		// same comparison `attendance-plan.ts` makes for the same reason.
		if (err instanceof Error) {
			if (err.message === CLUB_ARCHIVED_MESSAGE) {
				return {
					ok: false,
					message: err.message,
					view: ARCHIVED,
					applied: null,
				};
			}
			if (
				err.message === NOT_A_MEMBER_MESSAGE ||
				err.message === NO_PERMISSION_MESSAGE
			) {
				// Not-found, matching the load path: there is no page for them
				// either way, and a permission message on its own would confirm the
				// plan exists.
				return {
					ok: false,
					message: err.message,
					view: NOT_FOUND,
					applied: null,
				};
			}
		}
		if (!(err instanceof McpError)) throw err;
		// No `ARCHIVED` arm, for the same reason as the render path: the archive
		// refusal inside the lock comes from `assertStillClubAdmin` as a plain
		// `Error` carrying `CLUB_ARCHIVED_MESSAGE`, which the branch above
		// already handles. `applyGuestBookPlan` raises no `McpError("ARCHIVED")`.
		if (err.code === "NOT_FOUND") {
			return {
				ok: false,
				message: err.message,
				view: NOT_FOUND,
				applied: null,
			};
		}
		// `PLAN_STALE`, `BLOCKED` and anything else: nothing was written, so show
		// the plan as it stands NOW beside the sentence saying why.
		const after = await reread(input.pendingId, input.userId);
		return {
			ok: false,
			message: err.message,
			view: after ? await renderPendingPlan(after) : NOT_FOUND,
			applied: null,
		};
	}
}

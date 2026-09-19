/**
 * Every decision the guest-book confirm page makes (#806).
 *
 * `createServerFn` handler bodies cannot be executed from vitest — they need
 * the Start runtime — so a decision written inside one is a decision no test in
 * this repo can reach. (`club-logo-method.guard.test.ts` is the standing
 * precedent: a transport property invisible to the whole suite.) So the
 * wrappers in `guest-book-pending.ts` resolve the session and delegate, and
 * everything that DECIDES lives here, where an integration test can call it
 * directly:
 *
 *   - creator-only (AC5),
 *   - the archive gate on the READ path (AC15),
 *   - expiry and its grace window (AC11, AC12),
 *   - mapping an `McpError` out of `plan()` onto a page state, so no MCP error
 *     ever reaches a route error boundary (AC16),
 *   - and the sweep the poller runs.
 *
 * The WRITE is delegated to `guest-book-apply.ts`, which owns the lock, the
 * in-transaction re-check and the `applied_at IS NULL` guard.
 *
 * ## Why the read path carries its own archive gate
 *
 * `public-readers-archive-gate.guard.test.ts:548` drops any `src/server/`
 * server fn whose body calls a `require*` guard from its sweep. The wrappers
 * call `requireUser()`, so they are dropped — and a load path that checked only
 * the session and the creator would keep that guard green while rendering a
 * taken-down club's visitor names, emails and phone numbers. The gate is
 * therefore called explicitly, by name, on every path through this module.
 *
 * ## Why `requireClubRole` runs here and not in the wrapper
 *
 * It gates on a CLUB, and the input names only a pending plan, so the row has
 * to be read before the guard can be asked anything. Reading it in the wrapper
 * would put the lookup — and then the not-found and the creator comparison that
 * depend on it — in exactly the place no test can execute. AC5 and AC15 are
 * assertions about that check, so it lives where they can reach it. The
 * wrappers keep `requireUser()`, which is what the archive-gate sweep
 * classifies on, and add nothing else.
 */
import { eq, lt } from "drizzle-orm";
import { db } from "#/db";
import { clubs, guestBookPendingPlans } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	applyPendingEntryEdit,
	entryIdForBlockingIndex,
	isPendingPlanExpired,
	livePendingEntries,
	type PendingEntry,
	type PendingEntryEdit,
	pendingPlanArgs,
	pendingPlanSweepCutoff,
} from "#/lib/guest-book-pending";
import { loadClubDefaultCountryCode } from "#/server/clubs-logic";
import {
	assertClubNotArchived,
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	requireClubRole,
} from "#/server/guards";
import {
	type ApplyGuestBookPlanResult,
	applyGuestBookPlan,
} from "#/server/guest-book-apply";
import {
	type AmbiguousGuestDetail,
	type GuestBookCandidate,
	type GuestBookOutcome,
	guestBookPlanHash,
	plan,
	planSummary,
} from "#/server/guest-book-plan";
import { type McpBlockingCode, McpError } from "#/server/mcp/errors";

type Conn =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

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
	meetingDate: string;
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

interface PendingRow {
	id: string;
	clubId: string;
	clubName: string;
	timezone: string;
	meetingDate: string;
	createdByUserId: string;
	entries: PendingEntry[] | null;
	expiresAt: Date;
	appliedAt: Date | null;
}

const NOT_FOUND: PendingPlanView = { status: "not_found" };
const ARCHIVED: PendingPlanView = {
	status: "archived",
	message: CLUB_ARCHIVED_MESSAGE,
};

function headerOf(row: PendingRow): PendingPlanHeader {
	return {
		pendingId: row.id,
		clubId: row.clubId,
		clubName: row.clubName,
		meetingDate: row.meetingDate,
		expiresAt: row.expiresAt.toISOString(),
	};
}

async function readRow(pendingId: string): Promise<PendingRow | null> {
	const [row] = await db
		.select({
			id: guestBookPendingPlans.id,
			clubId: guestBookPendingPlans.clubId,
			clubName: clubs.name,
			timezone: clubs.timezone,
			meetingDate: guestBookPendingPlans.meetingDate,
			createdByUserId: guestBookPendingPlans.createdByUserId,
			entries: guestBookPendingPlans.entries,
			expiresAt: guestBookPendingPlans.expiresAt,
			appliedAt: guestBookPendingPlans.appliedAt,
		})
		.from(guestBookPendingPlans)
		.innerJoin(clubs, eq(clubs.id, guestBookPendingPlans.clubId))
		.where(eq(guestBookPendingPlans.id, pendingId))
		.limit(1);
	return row ?? null;
}

type Resolved =
	| { ok: true; row: PendingRow; actorMemberId: string | null }
	| { ok: false; view: PendingPlanView };

/**
 * The four checks every path through this module starts with, in this order,
 * and the order is the point.
 *
 *   1. The row exists.
 *   2. The caller is its CREATOR. Not "an admin of the club": the confirm page
 *      shows unmasked visitor contact details that only the person who
 *      transcribed the page has a reason to be reading, and AC5 makes even
 *      another admin of the same club a not-found.
 *   3. The club is not archived. After the creator check, so this never tells a
 *      stranger that a club exists — and the creator, who was an admin when
 *      they made the row, is owed the real explanation rather than a not-found.
 *   4. The creator still qualifies as an admin. A pending row must not outlive
 *      the standing that made it, and when that standing is gone the answer is
 *      not-found again: there is no page for them either way, and a permission
 *      message would confirm the plan exists.
 */
async function resolvePending(
	pendingId: string,
	userId: string,
): Promise<Resolved> {
	const row = await readRow(pendingId);
	if (!row) return { ok: false, view: NOT_FOUND };
	if (row.createdByUserId !== userId) return { ok: false, view: NOT_FOUND };

	try {
		await assertClubNotArchived(row.clubId);
	} catch {
		return { ok: false, view: ARCHIVED };
	}

	try {
		const membership = await requireClubRole(userId, row.clubId, ["admin"]);
		return { ok: true, row, actorMemberId: membership.id };
	} catch {
		return { ok: false, view: NOT_FOUND };
	}
}

/**
 * Re-plan and project. Called on load, after every edit, and after a refused
 * apply — one mapping, so the three can never render different things about
 * the same row.
 */
async function renderPendingPlan(row: PendingRow): Promise<PendingPlanView> {
	const header = headerOf(row);
	if (row.appliedAt) {
		return {
			...header,
			status: "applied",
			appliedAt: row.appliedAt.toISOString(),
		};
	}
	if (isPendingPlanExpired(row)) return { ...header, status: "expired" };

	const entries = row.entries ?? [];
	const club = { clubId: row.clubId, timezone: row.timezone };
	const countryCode = await loadClubDefaultCountryCode(row.clubId);

	let planned: Awaited<ReturnType<typeof plan>>;
	try {
		planned = await plan(
			db,
			club,
			{ meetingDate: row.meetingDate, ...pendingPlanArgs(entries) },
			countryCode,
		);
	} catch (err) {
		// `plan()` throws `McpError` for a meeting that has not happened yet, and
		// this page re-plans through the same function — so the error has to become
		// a page STATE here. Letting one escape would surface as a route error
		// boundary on a URL whose whole job is to explain what is wrong (AC16).
		// Anything that is not an `McpError` is a real failure and is rethrown.
		if (err instanceof McpError) {
			if (err.code === "ARCHIVED") return ARCHIVED;
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
	const resolved = await resolvePending(input.pendingId, input.userId);
	if (!resolved.ok) return resolved.view;
	return renderPendingPlan(resolved.row);
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
	const resolved = await resolvePending(input.pendingId, input.userId);
	if (!resolved.ok) return resolved.view;
	const { row } = resolved;

	// An applied or expired plan is not editable. Re-rendering rather than
	// throwing keeps one mapping for the page: it gets the same view it would
	// have got from a fresh load.
	if (row.appliedAt || isPendingPlanExpired(row)) {
		return renderPendingPlan(row);
	}

	const entries = applyPendingEntryEdit(row.entries ?? [], input.edit);
	await db
		.update(guestBookPendingPlans)
		.set({ entries })
		.where(eq(guestBookPendingPlans.id, input.pendingId));

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
	const resolved = await resolvePending(input.pendingId, input.userId);
	if (!resolved.ok) {
		return { ok: false, message: null, view: resolved.view, applied: null };
	}
	const { row, actorMemberId } = resolved;

	if (row.appliedAt || isPendingPlanExpired(row)) {
		return {
			ok: false,
			message: row.appliedAt
				? "That page has already been recorded."
				: "That confirmation link has expired.",
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
		const after = await readRow(input.pendingId);
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
		if (err.code === "ARCHIVED") {
			return { ok: false, message: err.message, view: ARCHIVED, applied: null };
		}
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
		const after = await readRow(input.pendingId);
		return {
			ok: false,
			message: err.message,
			view: after ? await renderPendingPlan(after) : NOT_FOUND,
			applied: null,
		};
	}
}

/**
 * Delete pending rows past the grace window — applied tombstones and abandoned
 * plans alike.
 *
 * Exported and called by the reminder poller, like every other poller pass:
 * a pass with no exported home cannot be called by a test, and AC12 is an
 * assertion about exactly where the boundary falls.
 *
 * The boundary is `pendingPlanSweepCutoff`, the same arithmetic the "expired"
 * page state is measured against, so the two windows cannot drift apart into a
 * gap where a row is gone but the page still promises an explanation.
 */
export async function sweepExpiredPendingPlans(
	conn: Conn = db,
	now: Date = new Date(),
): Promise<{ deleted: number }> {
	const result = await conn
		.delete(guestBookPendingPlans)
		.where(lt(guestBookPendingPlans.expiresAt, pendingPlanSweepCutoff(now)));
	return { deleted: result.rowCount ?? 0 };
}

/**
 * Every decision the agenda confirm page makes (#808).
 *
 * A server fn's handler body cannot be executed from vitest — it needs the Start
 * runtime — so a decision written inside one is a decision no test in this repo
 * can reach. So the wrappers in `agenda-plan-pending.ts` resolve the session and
 * delegate, and everything that DECIDES lives here, where an integration test
 * can call it directly.
 *
 * ## What is here, and what is one module over
 *
 * The LIFECYCLE is shared with every other MCP write tool and lives in
 * `src/server/mcp-pending-logic.ts`: the four ordered resolution checks
 * (exists-and-is-this-tool's, creator-only, the archive gate, still-an-admin),
 * and the sweep. `src/server/mcp-pending-apply.ts` owns the locked claim, and
 * `src/lib/pending-plan.ts` owns the expiry arithmetic. None of that is agenda
 * knowledge.
 *
 * What stays here is what only this tool can say about its own payload: reading
 * `{ meetings }` out of the shared `payload` column, re-planning it and
 * projecting the page, and mapping an `McpError` out of the apply onto a page
 * state so no MCP error ever reaches a route error boundary.
 *
 * ## There is no edit path, and that is a decision
 *
 * The guest-book page PATCHes corrections into its row because its payload is a
 * TRANSCRIPTION — a misread email is the likeliest thing on the page. Here every
 * value came from the caller as typed, the page's job is to show what 52 dates
 * would do before they happen, and the correction for a wrong theme is to ask
 * again. So this module is load-and-apply, and the row is immutable between the
 * two.
 */
import { db } from "#/db";
import {
	AGENDA_ALREADY_APPLIED_MESSAGE,
	AGENDA_EXPIRED_MESSAGE,
	AGENDA_UNREADABLE_MESSAGE,
	type AgendaEntry,
} from "#/lib/agenda-upsert";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { isPendingPlanExpired, UPSERT_AGENDAS_TOOL } from "#/lib/pending-plan";
import {
	type AgendaPlanLine,
	agendaPlanHash,
	agendaPlanSummary,
	plan,
} from "#/server/agenda-plan";
import {
	type ApplyAgendaPlanResult,
	applyAgendaPlan,
} from "#/server/agenda-plan-apply";
import {
	type AgendaAppliedSummary,
	parseAgendaPayload,
} from "#/server/agenda-plan-pending-schemas";
import { NO_PERMISSION_MESSAGE, NOT_A_MEMBER_MESSAGE } from "#/server/guards";
import { type McpBlockingCode, McpError } from "#/server/mcp/errors";
import {
	PENDING_ARCHIVED,
	PENDING_NOT_FOUND,
	type PendingPlanRow,
	resolvePending,
} from "#/server/mcp-pending-logic";

/** The tool every read in this module names. See `resolvePending`. */
export const AGENDA_PLAN_TOOL = UPSERT_AGENDAS_TOOL;

/**
 * A blocking item as the confirm page needs it.
 *
 * Built explicitly rather than by re-exporting `McpBlockingItem`, whose `detail`
 * is `unknown` — a server fn return crosses a serialization boundary that
 * refuses it, and the page should be able to name the date an item is about
 * without casting its way into a bag of unknowns.
 */
export interface AgendaBlockingItem {
	code: McpBlockingCode;
	message: string;
	/** Index into the stored `meetings` list, or null for a call-wide item. */
	entryIndex: number | null;
	/** The club-local date this is about, when it has one. */
	date: string | null;
}

export interface AgendaPendingHeader {
	pendingId: string;
	clubId: string;
	clubName: string;
	/** ISO, for rendering. */
	expiresAt: string;
}

/**
 * What the route renders. A discriminated union rather than a bag of nullable
 * fields, so a state that carries no plan cannot be rendered with one.
 */
export type AgendaPendingView =
	/** Unknown id, the wrong tool, a different user's plan, or a creator who is
	 *  no longer an admin. */
	| { status: "not_found" }
	| { status: "archived"; message: string }
	| ({ status: "expired" } & AgendaPendingHeader)
	| ({
			status: "applied";
			appliedAt: string;
			/** Null only when the tombstone itself did not parse. */
			applied: AgendaAppliedSummary | null;
	  } & AgendaPendingHeader)
	/** The payload came from a release this one cannot read. Nothing to approve. */
	| ({ status: "unreadable"; message: string } & AgendaPendingHeader)
	| ({
			status: "editable";
			/**
			 * How many dates the caller NAMED.
			 *
			 * Not `lines.length`: a blocked date produces no plan line, so counting
			 * lines would head a table of five rows with "4 dates" — which reads as
			 * a row the page has quietly dropped, on a page whose whole job is to
			 * account for every date before anything is written.
			 */
			entryCount: number;
			lines: AgendaPlanLine[];
			blocking: AgendaBlockingItem[];
			summary: ReturnType<typeof agendaPlanSummary>;
			/** Provisional numbers by line index — shown, never hashed. */
			meetingNumbers: Record<number, number | null>;
			planHash: string;
	  } & AgendaPendingHeader);

/** A pending row with this tool's payload parsed out. */
interface AgendaPendingRow extends PendingPlanRow {
	entries: AgendaEntry[] | null;
	entriesUnreadable: boolean;
	applied: AgendaAppliedSummary | null;
}

const NOT_FOUND: AgendaPendingView = { ...PENDING_NOT_FOUND };
const ARCHIVED: AgendaPendingView = { ...PENDING_ARCHIVED };

function headerOf(row: AgendaPendingRow): AgendaPendingHeader {
	return {
		pendingId: row.id,
		clubId: row.clubId,
		clubName: row.clubName,
		expiresAt: row.expiresAt.toISOString(),
	};
}

/** Read this tool's payload off a row the lifecycle has already resolved. */
function withPayload(row: PendingPlanRow): AgendaPendingRow {
	// PARSE, do not trust the column's compile-time type. See
	// `parseAgendaPayload` for the deploy boundary this closes.
	const payload = parseAgendaPayload(row.payload);
	if (!payload) {
		return { ...row, entries: null, entriesUnreadable: true, applied: null };
	}
	return {
		...row,
		entries: payload.entries,
		entriesUnreadable: payload.entriesUnreadable,
		applied: payload.applied,
	};
}

/**
 * Re-plan and project. Called on load and after a refused apply — one mapping,
 * so the two can never render different things about the same row.
 */
async function renderPendingPlan(
	row: AgendaPendingRow,
): Promise<AgendaPendingView> {
	const header = headerOf(row);
	if (row.appliedAt) {
		return {
			...header,
			status: "applied",
			appliedAt: row.appliedAt.toISOString(),
			applied: row.applied,
		};
	}
	if (isPendingPlanExpired(row)) return { ...header, status: "expired" };
	if (row.entriesUnreadable || row.entries === null) {
		return {
			...header,
			status: "unreadable",
			message: AGENDA_UNREADABLE_MESSAGE,
		};
	}

	const planned = await plan(
		db,
		{ clubId: row.clubId, timezone: row.timezone },
		row.entries,
	);

	return {
		...header,
		status: "editable",
		entryCount: row.entries.length,
		lines: planned.plan.lines,
		blocking: planned.blocking.map((item): AgendaBlockingItem => {
			const detail = item.detail as { date?: string } | undefined;
			return {
				code: item.code,
				message: item.message,
				entryIndex: item.entryIndex ?? null,
				date: detail?.date ?? null,
			};
		}),
		summary: agendaPlanSummary(planned.plan),
		meetingNumbers: planned.meetingNumbers,
		// Hashed exactly as the MCP preview hashed it: the creator is the hash's
		// `userId` on both sides, so a plan previewed by them and applied by them
		// is the same function of the same inputs.
		planHash: agendaPlanHash({
			clubId: row.clubId,
			userId: row.createdByUserId,
			plan: planned.plan,
		}),
	};
}

/**
 * Re-read one row, for the place that needs to see what is stored NOW after a
 * write it did not fully control.
 *
 * Through `resolvePending` rather than a second SELECT of its own: the four
 * ordered checks have exactly one definition, and a private re-read here would
 * be a second read path whose WHERE could forget the tool discriminator.
 *
 * Returns the REFUSAL, not null, when the re-resolve declines — a club taken
 * down between the apply landing and this re-read should answer "archived", the
 * same as a fresh load of the same row, rather than "that link doesn't point at
 * anything".
 */
type Reread =
	| { ok: true; row: AgendaPendingRow }
	| { ok: false; refusal: AgendaPendingView };

async function reread(pendingId: string, userId: string): Promise<Reread> {
	const resolved = await resolvePending(pendingId, userId, AGENDA_PLAN_TOOL);
	return resolved.ok
		? { ok: true, row: withPayload(resolved.row) }
		: { ok: false, refusal: resolved.refusal };
}

export async function loadPendingPlan(input: {
	pendingId: string;
	userId: string;
}): Promise<AgendaPendingView> {
	const resolved = await resolvePending(
		input.pendingId,
		input.userId,
		AGENDA_PLAN_TOOL,
	);
	if (!resolved.ok) return resolved.refusal;
	return renderPendingPlan(withPayload(resolved.row));
}

export interface ApplyAgendaPendingResult {
	ok: boolean;
	/** One sentence for the person who clicked, when it refused. */
	message: string | null;
	/** What to render now — a fresh plan on a refusal, the tombstone on success. */
	view: AgendaPendingView;
	/** Present only on success. */
	applied: ApplyAgendaPlanResult | null;
}

/**
 * Apply, and turn every refusal into a page state.
 *
 * `agenda-plan-apply.ts` throws `McpError` so its transaction rolls back; the
 * route needs data, not an exception — an error crossing a server-fn boundary
 * arrives as a bare message with no code on it. So the codes are mapped here,
 * once, and the caller always gets a view it can render.
 */
export async function applyPendingPlan(input: {
	pendingId: string;
	userId: string;
	planHash: string;
}): Promise<ApplyAgendaPendingResult> {
	const resolved = await resolvePending(
		input.pendingId,
		input.userId,
		AGENDA_PLAN_TOOL,
	);
	if (!resolved.ok) {
		return { ok: false, message: null, view: resolved.refusal, applied: null };
	}
	const { actorMemberId } = resolved;
	const row = withPayload(resolved.row);

	const unreadable = row.entriesUnreadable || row.entries === null;
	if (row.appliedAt || isPendingPlanExpired(row) || unreadable) {
		return {
			ok: false,
			// The CHEAP, unlocked pre-check's sentence. It is deliberately not the
			// one the locked guard gives — see `AGENDA_APPLIED_WHILE_OPEN_MESSAGE`,
			// and `agenda-upsert.test.ts` for the assertion that they differ.
			message: row.appliedAt
				? AGENDA_ALREADY_APPLIED_MESSAGE
				: unreadable
					? AGENDA_UNREADABLE_MESSAGE
					: AGENDA_EXPIRED_MESSAGE,
			view: await renderPendingPlan(row),
			applied: null,
		};
	}

	try {
		const applied = await applyAgendaPlan({
			pendingId: row.id,
			club: { clubId: row.clubId, timezone: row.timezone },
			userId: input.userId,
			actorMemberId,
			planHash: input.planHash,
		});
		// Re-read: the row is a tombstone now, and the applied view is built from
		// what is actually stored rather than from what this function assumed.
		const after = await reread(input.pendingId, input.userId);
		return {
			ok: true,
			message: null,
			view: after.ok ? await renderPendingPlan(after.row) : after.refusal,
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
		// the one sanctioned exception `src/server/mcp/errors.ts` names.
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
			view: after.ok ? await renderPendingPlan(after.row) : after.refusal,
			applied: null,
		};
	}
}

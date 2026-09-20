/**
 * The pending-plan lifecycle's READ half, shared by every MCP write tool (#812).
 *
 * One table, one resolver, one sweep. What is NOT here is per-tool planning and
 * per-tool pages: an agenda diff and a guest table share no markup and no plan
 * shape, and forcing them through one renderer would be the over-abstraction
 * this extraction exists to avoid. What IS here is everything a second copy of
 * would eventually diverge on — who may open a row, whether it is still open,
 * and when it stops existing.
 *
 * ## Why this is a `-logic.ts` and not a server-fn module
 *
 * `createServerFn` handler bodies cannot be executed from vitest — they need the
 * Start runtime — so a decision written inside one is a decision no test in this
 * repo can reach. Every rule below is therefore callable directly, and each
 * tool's thin wrappers resolve the session and delegate.
 *
 * ## Why this is not under `src/server/mcp/`
 *
 * `mcp-authz.guard.test.ts` fails any `.ts` under `src/server/mcp/` that imports
 * a session guard, and it should: `/api/mcp` is bearer-only, and that is the
 * whole CSRF posture. This resolver is authorized by a SESSION, so it cannot
 * live there — the same reason `guest-book-plan.ts` sits one directory up.
 */
import { and, eq, lt } from "drizzle-orm";
import { db } from "#/db";
import { clubs, mcpPendingPlans } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	type McpPendingTool,
	type PendingSweepResult,
	pendingPlanSweepCutoff,
} from "#/lib/pending-plan";
import { assertClubNotArchived, requireClubRole } from "#/server/guards";

type Conn =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * A pending row as the lifecycle sees it: everything except what is in the
 * payload, which only the owning tool can read.
 */
export interface PendingPlanRow {
	id: string;
	clubId: string;
	clubName: string;
	timezone: string;
	tool: McpPendingTool;
	createdByUserId: string;
	/** The tool's own shape. PARSE it; the column's type is a compile-time cast. */
	payload: unknown;
	expiresAt: Date;
	appliedAt: Date | null;
}

/**
 * The two states in which there is no page, for any tool.
 *
 * Deliberately the whole refusal vocabulary: every other outcome — expired,
 * applied, unplannable, editable — is a statement about a payload, and only the
 * tool that wrote it can make one.
 */
export type PendingRefusal =
	/** Unknown id, the wrong tool, a different user's plan, or a creator who is
	 * no longer an admin. */
	{ status: "not_found" } | { status: "archived"; message: string };

export const PENDING_NOT_FOUND: PendingRefusal = { status: "not_found" };
export const PENDING_ARCHIVED: PendingRefusal = {
	status: "archived",
	message: CLUB_ARCHIVED_MESSAGE,
};

export type ResolvedPending =
	| { ok: true; row: PendingPlanRow; actorMemberId: string | null }
	| { ok: false; refusal: PendingRefusal };

/**
 * The four checks every path through every tool starts with, in this order, and
 * the order is the point.
 *
 *   1. The row exists AND was made by the tool the caller expects.
 *   2. The caller is its CREATOR. Not "an admin of the club": a confirm page
 *      shows the unmasked values that only the person who proposed the write
 *      has a reason to be reading, and even another admin of the same club is a
 *      not-found.
 *   3. The club is not archived. After the creator check, so this never tells a
 *      stranger that a club exists — and the creator, who was an admin when they
 *      made the row, is owed the real explanation rather than a not-found.
 *   4. The creator still qualifies as an admin. A pending row must not outlive
 *      the standing that made it, and when that standing is gone the answer is
 *      not-found again: there is no page for them either way, and a permission
 *      message would confirm the plan exists.
 *
 * ## Why the tool is an argument and not a return value
 *
 * Two tables made "a guest-book id opened at the agenda page" unrepresentable.
 * One table makes it a missing `WHERE`, and the failure is SILENT: both pages
 * load by id and check the creator, so a mismatched id passes that check and
 * reaches a renderer built for a different shape — drawing an empty plan over
 * live contact details, because `payload.meetings` is simply undefined. So the
 * mismatch is answered at the one seam every read passes through, with the same
 * `not_found` a wrong id already gets.
 *
 * ## Why `requireClubRole` runs here and not in a wrapper
 *
 * It gates on a CLUB, and the input names only a pending plan, so the row has to
 * be read before the guard can be asked anything. Reading it in a `createServerFn`
 * would put the lookup — and then the not-found and the creator comparison that
 * depend on it — in exactly the place no test can execute.
 *
 * ## Why the read path carries its own archive gate
 *
 * `public-readers-archive-gate.guard.test.ts` drops any `src/server/` server fn
 * whose body calls a `require*` guard from its sweep. The wrappers call
 * `requireUser()`, so they are dropped — and a load path that checked only the
 * session and the creator would keep that guard green while rendering a taken-down
 * club's data. The gate is therefore called explicitly, by name, here.
 */
export async function resolvePending(
	pendingId: string,
	userId: string,
	tool: McpPendingTool,
): Promise<ResolvedPending> {
	const [row] = await db
		.select({
			id: mcpPendingPlans.id,
			clubId: mcpPendingPlans.clubId,
			clubName: clubs.name,
			timezone: clubs.timezone,
			tool: mcpPendingPlans.tool,
			createdByUserId: mcpPendingPlans.createdByUserId,
			payload: mcpPendingPlans.payload,
			expiresAt: mcpPendingPlans.expiresAt,
			appliedAt: mcpPendingPlans.appliedAt,
		})
		.from(mcpPendingPlans)
		.innerJoin(clubs, eq(clubs.id, mcpPendingPlans.clubId))
		// The tool is IN THE WHERE, not compared afterwards. A row whose tool
		// differs is indistinguishable from a row that does not exist — which is
		// the honest answer, and the one that cannot be forgotten by a caller.
		.where(
			and(eq(mcpPendingPlans.id, pendingId), eq(mcpPendingPlans.tool, tool)),
		)
		.limit(1);
	if (!row) return { ok: false, refusal: PENDING_NOT_FOUND };
	if (row.createdByUserId !== userId) {
		return { ok: false, refusal: PENDING_NOT_FOUND };
	}

	try {
		await assertClubNotArchived(row.clubId);
	} catch {
		return { ok: false, refusal: PENDING_ARCHIVED };
	}

	try {
		const membership = await requireClubRole(userId, row.clubId, ["admin"]);
		return { ok: true, row, actorMemberId: membership.id };
	} catch {
		return { ok: false, refusal: PENDING_NOT_FOUND };
	}
}

/**
 * Delete pending rows past the grace window — applied tombstones and abandoned
 * plans alike, whatever tool made them.
 *
 * Exported and called by the reminder poller, like every other poller pass: a
 * pass with no exported home cannot be called by a test, and where the boundary
 * falls is an assertion.
 *
 * The boundary is `pendingPlanSweepCutoff`, the same arithmetic the "expired"
 * page state is measured against, so the two windows cannot drift apart into a
 * gap where a row is gone but the page still promises an explanation.
 *
 * ## Why it counts per tool
 *
 * Not a test affordance — it is what the log should say once one sweep serves
 * two retentions. It also rescues an exact assertion that the merge would
 * otherwise break: the DELETE is unscoped by construction (the poller sweeps the
 * whole table) and vitest runs test FILES in parallel against one `tm_test`, so
 * a guest-book suite asserting a total would be reddened by an agenda suite's
 * in-flight rows for a reason that has nothing to do with it. `RETURNING tool`
 * costs one column on rows already being written.
 */
export async function sweepExpiredPendingPlans(
	conn: Conn = db,
	now: Date = new Date(),
): Promise<PendingSweepResult> {
	const removed = await conn
		.delete(mcpPendingPlans)
		.where(lt(mcpPendingPlans.expiresAt, pendingPlanSweepCutoff(now)))
		.returning({ tool: mcpPendingPlans.tool });
	const byTool: Record<string, number> = {};
	for (const row of removed) {
		byTool[row.tool] = (byTool[row.tool] ?? 0) + 1;
	}
	return { deleted: removed.length, byTool };
}

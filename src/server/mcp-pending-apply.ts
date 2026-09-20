/**
 * The pending-plan lifecycle's WRITE half: one locked transaction that turns a
 * pending plan into domain rows, shared by every MCP write tool (#812).
 *
 * This is the shape `record_guest_book` proved (#773 D5, #806):
 *
 *   lock the club → re-prove the caller's standing → re-read the row FOR UPDATE
 *   → refuse if it is already applied → refuse if it has expired
 *   → run THE TOOL'S apply against `tx` → claim the row and tombstone it
 *
 * Everything that decides is re-decided inside the lock, because the gap between
 * "the page rendered" and "the button was clicked" is unbounded — a confirm link
 * is open for up to a day — and every fact the plan rests on can move inside it.
 *
 * ## Why the skeleton is shared and the body is not
 *
 * The body is where a tool re-plans, compares its hash, refuses while anything
 * blocks, and writes. None of that generalises. The skeleton is the part that
 * would be copied verbatim and then diverge: the lock, the re-proved grant, the
 * `FOR UPDATE`, and — the one that matters — the `applied_at IS NULL` guard. A
 * second copy of "has this already been applied" anywhere else is how a
 * double-click writes a page twice, and there is exactly one here.
 *
 * ## Why this is its own module and not under `src/server/mcp/`
 *
 * `mcp-authz.guard.test.ts` fails any `.ts` under `src/server/mcp/` that imports
 * a session guard, and it should: `/api/mcp` is bearer-only, and that is the whole
 * CSRF posture. This apply is authorized by a SESSION, so it cannot live there.
 *
 * ## The payload is read HERE, inside the lock
 *
 * Not passed in. A confirm page PATCHes edits into the same row, so a payload
 * carried across from the render that produced a hash could be a version the
 * hash was never taken over. Reading it under the row lock makes the plan that
 * is hashed, the plan that is executed, and the plan that is stored one thing.
 */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { mcpPendingPlans } from "#/db/schema";
import { isPendingPlanExpired, type McpPendingTool } from "#/lib/pending-plan";
import { assertStillClubAdmin } from "#/server/guards";
import { McpError } from "#/server/mcp/errors";
import { lockClub } from "#/server/mcp/lock";

/** A drizzle transaction handle (mirrors `activity.ts`). */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** The locked row a tool's apply body is handed. */
export interface LockedPendingRow {
	id: string;
	/** The tool's own shape. PARSE it; the column's type is a compile-time cast. */
	payload: unknown;
	expiresAt: Date;
}

/**
 * What the body produces: the tool's own result, and what to leave behind.
 *
 * `tombstone` is written into `payload` in the SAME statement that sets
 * `applied_at`. Each tool decides what survives its own apply — the guest book
 * keeps the meeting date (its applied page still says which meeting the visitors
 * are on) and drops the transcribed lines, so no visitor's name, email or phone
 * sits here at rest once the write it justified has landed. `null` erases the
 * payload entirely.
 */
export interface PendingApplyOutcome<T> {
	result: T;
	tombstone: unknown;
}

/**
 * The sentences a refusal carries, supplied by the tool.
 *
 * Copy is per-tool: "that page" is right for a transcribed guest-book page and
 * wrong for a set of agendas. `alreadyApplied` carries one non-obvious
 * constraint, and it is MEASURED — it must not read the same as the sentence
 * the tool's own unlocked pre-check gives for a plan that was already applied
 * before the call started. #806 shipped twice with the two identical, and that
 * made the locked guard untestable: the cheap check short-circuits every serial
 * case, so an assertion matching both sentences passed without this line ever
 * running. A test can only prove the locked guard fires if the locked guard says
 * something only it says.
 */
export interface PendingApplyCopy {
	notFound: string;
	alreadyApplied: string;
	expired: string;
}

export interface ApplyPendingPlanLockedInput<T> {
	pendingId: string;
	/** The tool this row must belong to. Matched in the `FOR UPDATE`'s own WHERE. */
	tool: McpPendingTool;
	clubId: string;
	/** The session user, re-proved as an admin once the lock is held. */
	userId: string;
	copy: PendingApplyCopy;
	/** The tool's own apply, run against `tx` with the locked row. */
	apply: (tx: Tx, row: LockedPendingRow) => Promise<PendingApplyOutcome<T>>;
}

/**
 * Apply a pending plan under the club lock. Throws `McpError` on every refusal,
 * which rolls the transaction back; each tool's logic module maps those codes to
 * the page states its route renders.
 *
 * `McpError` rather than a second error vocabulary because the codes are the
 * same facts — `PLAN_STALE`, `BLOCKED`, `NOT_RECORDABLE` — raised by the same
 * planners these bodies call. Inventing a parallel set here would mean every
 * confirm page had to handle two names for each one.
 */
export async function applyPendingPlanLocked<T>(
	input: ApplyPendingPlanLockedInput<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		// Serialise applies on this club before reading anything, so the body's
		// re-plan sees a state no other apply can move underneath it.
		await lockClub(tx, input.clubId);

		// The grant was proved before this transaction opened, and the lock above
		// may have made it wait. Re-prove it against `tx` now that the lock is
		// held, for the same reason the plan is rebuilt inside it.
		await assertStillClubAdmin(tx, input.userId, input.clubId);

		// `FOR UPDATE` is what makes the `applied_at` check below atomic: a
		// concurrent apply of the same row blocks here rather than reading a row
		// it is about to have written out from under it.
		//
		// The tool is in the WHERE for the same reason `resolvePending` puts it
		// there: an id alone no longer says what shape the payload has, and a body
		// handed a foreign shape would not fail, it would plan nothing.
		const [row] = await tx
			.select({
				id: mcpPendingPlans.id,
				payload: mcpPendingPlans.payload,
				appliedAt: mcpPendingPlans.appliedAt,
				expiresAt: mcpPendingPlans.expiresAt,
			})
			.from(mcpPendingPlans)
			.where(
				and(
					eq(mcpPendingPlans.id, input.pendingId),
					eq(mcpPendingPlans.tool, input.tool),
				),
			)
			.for("update")
			.limit(1);

		if (!row) throw new McpError("NOT_FOUND", input.copy.notFound);

		// THE double-apply guard, and the only one. A second click, a replayed
		// request, or two tabs on the same link all arrive here. See
		// `PendingApplyCopy` for why its sentence must be unique to it.
		if (row.appliedAt !== null) {
			throw new McpError("BLOCKED", input.copy.alreadyApplied, {
				alreadyApplied: true,
			});
		}

		// Expiry is decided by `isPendingPlanExpired` and enforced twice: a tool's
		// logic module refuses first, so the page renders an "expired" state
		// instead of a failed apply, and this refuses again under the lock,
		// because a click can land on either side of the boundary. One predicate,
		// two enforcement points — the same shape the archive gate uses.
		if (isPendingPlanExpired(row)) {
			throw new McpError("BLOCKED", input.copy.expired, { expired: true });
		}

		const { result, tombstone } = await input.apply(tx, row);

		// The claim, in the same transaction as the body's writes. `applied_at` is
		// what makes a re-opened link say "already recorded" instead of
		// "not found"; the tombstone is what stops personal data sitting here at
		// rest once the write it justified has landed.
		//
		// The app clock, not `now()`. `created_at` and `expires_at` are written
		// from the app clock as UTC, and `now()` is a `timestamptz` cast into a
		// `timestamp` column through the session's TimeZone — so on a non-UTC
		// session this one column would disagree with the other two about what
		// time it is on the same row.
		await tx
			.update(mcpPendingPlans)
			.set({ appliedAt: new Date(), payload: tombstone })
			.where(eq(mcpPendingPlans.id, input.pendingId));

		return result;
	});
}

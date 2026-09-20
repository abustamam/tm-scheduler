/**
 * The pending-plan lifecycle's PURE half, shared by every MCP write tool (#812).
 *
 * `record_guest_book` (#806) established the machine: an LLM proposes a write,
 * a row records it, a human opens a link signed in and confirms it on a page.
 * Nothing about the row's LIFECYCLE is specific to the guest book — it belongs
 * to one club, it was made by one user, it expires, it survives unopenable for
 * a grace window, and a sweep eventually removes it. Only the payload and the
 * page are per-tool.
 *
 * So the lifecycle lives once. This module is the part of it with no database
 * and no request in it: the tool vocabulary, the expiry and grace arithmetic,
 * and the sweep's own report. `src/server/mcp-pending-logic.ts` owns the reads
 * and the sweep; `src/server/mcp-pending-apply.ts` owns the locked claim.
 *
 * Client-safe on purpose, and a LEAF: nothing here may import anything.
 *
 * `src/db/schema.ts` imports `McpPendingTool` from this module, and that file
 * is bundled into two standalone scripts that gate every container start. The
 * leaf rule is therefore load-bearing — but it is NOT enforced for this module,
 * and saying otherwise would be worse than saying nothing.
 * `table-topics-limits-wiring.guard.test.ts` pins the leaf property of
 * `src/lib/table-topics-limits.ts` by name and of no other module, and its
 * `outsideDb` sweep exempts whole-statement `import type` — which is exactly
 * how schema.ts imports this. So a value import added here would be caught by
 * neither. Keep it a leaf by hand until something enforces it.
 */

/**
 * The write tools that own a pending plan, and the `tool` column's vocabulary.
 *
 * `upsert_agendas` is declared before #808 builds it, and deliberately.
 * Merging the two tables means an id no longer says which tool made it, so
 * every read has to name the tool it expects — and the assertion that a
 * guest-book id opened with the AGENDA tool answers `not_found` is the whole
 * reason the discriminator exists. That test needs the second value to exist
 * today. It is exercised, not dead: a declared-but-unemitted member is the
 * drift `blocking-codes.guard.test.ts` removes, and this one is emitted by the
 * mismatch case in `guest-book-confirm.integration.test.ts`.
 */
export const MCP_PENDING_TOOLS = [
	"record_guest_book",
	"upsert_agendas",
] as const;

export type McpPendingTool = (typeof MCP_PENDING_TOOLS)[number];

/**
 * The guest book's own member, named once.
 *
 * Every read of a `record_guest_book` row filters on this value, and it was
 * spelled three times: two `as const` declarations and a bare literal at the
 * insert. `$type<McpPendingTool>` catches a TYPO in any of them, so the drift
 * that survives typecheck is one copy moving to the OTHER valid member —
 * measured, that reds 8 integration cases immediately rather than failing
 * silently, so this is tidiness and not a latent bug. It is still the shape
 * this change exists to remove.
 */
export const RECORD_GUEST_BOOK_TOOL: McpPendingTool = "record_guest_book";

/** A pending plan is openable for a day. */
export const PENDING_PLAN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * And survives, unopenable, for a day after that.
 *
 * The grace window is what keeps expiry and the sweep from racing: a plan that
 * has just expired renders an "expired" state — which is an explanation —
 * rather than vanishing into "never existed", which reads like a bug. The sweep
 * only removes rows past BOTH windows.
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

/**
 * What one sweep removed, broken down by the tool that made each row.
 *
 * `byTool` is keyed by the RAW column value rather than by `McpPendingTool`,
 * because a sweep runs against whatever is in the table. Migrations apply at
 * container startup with no drain, so a row written by the next release —
 * carrying a tool this one has never heard of — is swept by this one, and a
 * count that silently dropped it would under-report the only thing in the
 * system that deletes these rows.
 */
export interface PendingSweepResult {
	deleted: number;
	byTool: Record<string, number>;
}

/**
 * One log line for a sweep, or null when it removed nothing.
 *
 * A pure function rather than a template inside the poller: `sweepTick` is a
 * private function in a module that starts timers on import, so a line written
 * there is a line no test can read. Once one sweep serves two tools, "swept 4"
 * stops saying which retention actually ran.
 */
export function describePendingSweep(
	result: PendingSweepResult,
): string | null {
	if (result.deleted <= 0) return null;
	const breakdown = Object.entries(result.byTool)
		// Sorted by NAME, not by count: the line is read across ticks, and a
		// count-ordered breakdown reorders itself between two runs that swept
		// the same tools.
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([tool, n]) => `${tool} ${n}`)
		.join(", ");
	return `[mcp-pending] swept ${result.deleted} expired pending plan(s): ${breakdown}`;
}

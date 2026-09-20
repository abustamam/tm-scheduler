/**
 * Driving the club advisory lock from a test, deterministically.
 *
 * Every MCP apply runs inside `applyPendingPlanLocked`, which takes
 * `pg_advisory_xact_lock` on the club before it reads anything. The rules that
 * only run INSIDE that lock — the `applied_at IS NULL` guard, the re-plan, the
 * re-proved grant — are unreachable serially: a cheaper check outside the
 * transaction answers first in every ordinary ordering, so an assertion written
 * against a serial call passes whether the locked rule exists or not. #806
 * shipped exactly that twice.
 *
 * The harness makes the interleaving real. A second connection takes the club's
 * lock and HOLDS it; the apply is started and parks; `pg_locks` is polled until
 * an ungranted advisory lock on this club's key appears — and that observation
 * is the CONTROL, because it proves the apply is already inside its transaction
 * and past every up-front check, so a refusal afterwards cannot be one of them.
 * Only then does the test move the world underneath it and let go.
 *
 * Extracted from `guest-book-confirm-revocation.integration.test.ts` (#776 item
 * 8, #806) when `upsert_agendas` needed the same two moves (#808). One copy,
 * because the thing it is used to prove is that two code paths say DIFFERENT
 * things — and two harnesses drifting apart is how one of them quietly stops
 * parking at all and starts measuring a serial call again.
 */
import { sql } from "drizzle-orm";
import { testDb } from "./db";

/** Take the club's advisory lock on a connection of its own and hold it. */
export function holdClubLock(clubId: string) {
	let letGo!: () => void;
	let taken!: () => void;
	const held = new Promise<void>((resolve) => {
		letGo = resolve;
	});
	const acquired = new Promise<void>((resolve) => {
		taken = resolve;
	});
	const finished = testDb.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${clubId}))`);
		taken();
		await held;
	});
	return {
		acquired,
		async release() {
			letGo();
			await finished;
		},
	};
}

/**
 * How many sessions are WAITING on this club's advisory lock right now.
 *
 * Module-private: `awaitLockWaiter` is the only caller, and an exported helper
 * nothing imports is dead weight that neither Biome nor `noUnusedLocals` can
 * see. Export it the day a suite needs the raw count.
 */
async function waitersOnClubLock(clubId: string): Promise<number> {
	const res = await testDb.execute<{ n: number }>(sql`
		SELECT count(*)::int AS n
		FROM pg_locks
		WHERE locktype = 'advisory'
		  AND NOT granted
		  AND objid::bigint = (hashtext(${clubId})::bigint & 4294967295)
	`);
	return Number(res.rows[0]?.n ?? 0);
}

/**
 * Resolve once the apply is parked on the lock, or fail LOUDLY.
 *
 * The loud failure is the point: without this observation a test that refused
 * for an ordinary up-front reason would look exactly like one that reached the
 * locked guard.
 */
export async function awaitLockWaiter(clubId: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if ((await waitersOnClubLock(clubId)) > 0) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(
		"the apply never parked on the club advisory lock — the race this test sets up did not happen, so a refusal below would prove nothing",
	);
}

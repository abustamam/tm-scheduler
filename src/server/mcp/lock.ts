/**
 * The club lock every MCP apply takes (#773, design D5/T12).
 *
 * `guests` has no unique constraint on contact — the dedup rule is #488's
 * name-qualified one, which no index can express — so two applies transcribing
 * the same guest-book page concurrently would each plan "new" and each insert.
 * A club-scoped advisory lock serialises MCP applies with each other, and the
 * re-plan inside the transaction turns a lost race into an honest `PLAN_STALE`
 * rather than a duplicate row.
 *
 * `pg_advisory_xact_lock` takes a bigint, and a club id is a uuid, so the key
 * has to be DERIVED. `hashtext()` is Postgres's own function, stable within a
 * major version, and the consequence of a collision is bounded: two different
 * clubs' applies briefly wait for each other. That is a latency cost on a path
 * used by one authenticated admin at a time, not a correctness one.
 *
 * `_xact_` matters: the lock releases when the transaction ends, commit or
 * rollback, so an apply that throws cannot strand it. There is deliberately no
 * unlock helper — having one would imply a path that releases early.
 *
 * ONE helper, because a lock only excludes callers that agree on the key. Two
 * apply paths deriving their own would both appear to take "the club lock" and
 * would not exclude each other at all.
 *
 * NOT taken by `submitGuestBook`: a public guest-book signature can still land
 * inside an apply transaction. The transaction-scoped re-plan narrows that to
 * the transaction itself, which is the right trade for a public path that must
 * never block on an officer's batch (design open question 3).
 */
import { sql } from "drizzle-orm";
import type { db } from "#/db";

/** A drizzle transaction handle (mirrors `activity.ts`). */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Take the club's advisory lock for the rest of this transaction.
 *
 * Blocks until it is granted. MUST be called on a `tx`, not on `db`: on the
 * pooled client the lock would be taken and released on whatever connection the
 * pool handed out, guarding nothing.
 */
export async function lockClub(tx: Tx, clubId: string): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${clubId}))`);
}

/**
 * The club write lock (#925): ONE transaction-scoped advisory lock per club,
 * taken FIRST by every writer that row-locks both a club and one of its
 * meetings.
 *
 * Why it exists. Those writers could not agree on a row-lock order, and no
 * single order satisfies all of them as written:
 *
 * | Writer                             | Row locks, in order                          |
 * |------------------------------------|----------------------------------------------|
 * | `joinBallotAsGuest`                | meeting FOR UPDATE, then club FOR SHARE       |
 * | `openVote`                         | meeting + club FOR SHARE, one statement       |
 * | `captureGuestVisit`                | club, then the meeting (attendance FK)        |
 * | `saveMeetingAgendaAsClubTemplate`  | meeting FOR UPDATE, then club NO KEY UPDATE   |
 *
 * so a guest checking in while another joins the ballot, or while an officer
 * saves that meeting's agenda as a template, was a Postgres 40P01. Taking this
 * lock before the first row lock serialises those writers per club, so the row
 * locks behind it are only ever contended by one of them at a time and the
 * order they take them in stops mattering between them. It ORDERS the rows; it
 * replaces none of them — each writer keeps every row lock it needs for its own
 * correctness (the ballot cap, the guest-book throttle, the archive gate).
 *
 * THE KEY SPACE. `pg_advisory_xact_lock` has two key forms, one bigint and two
 * int4s, and Postgres keeps them apart (`pg_locks.objsubid` is 1 for the first
 * and 2 for the second), so a two-int key can never equal a bigint key whatever
 * the values. Every other advisory lock in this app is a bigint — the MCP apply
 * lock (`mcp/lock.ts`, `hashtext(clubId)`), the guest-convert lock
 * (`lockClubConverts`), and `submitAccessRequestLogic`'s global
 * `access-requests:submit` key — so this one uses the two-int form, with a
 * fixed namespace as the first int. That is the property that matters, and it
 * is structural rather than probabilistic:
 *
 * - It cannot collide with the access-request lock, so a busy club never holds
 *   the public request-access form up, or the reverse.
 * - It cannot collide with the MCP apply lock. That one matters more than a
 *   latency cost: an MCP apply holds its club lock on one connection, and if
 *   anything it called opened a second transaction wanting the SAME key, it
 *   would wait on itself forever — Postgres cannot see a cycle that runs
 *   through the application.
 *
 * Two clubs whose ids share a `hashtext` value share a key, which costs them
 * only a brief wait for each other (the same bounded trade `mcp/lock.ts`
 * documents).
 *
 * `_xact_`: released at commit or rollback, so a writer that throws cannot
 * strand it, and there is deliberately no unlock helper. Re-entrant within a
 * transaction, so a helper that takes it again under a caller that already
 * holds it is a no-op.
 */
import { sql } from "drizzle-orm";
import type { db } from "#/db";

/** A drizzle transaction handle (mirrors `mcp/lock.ts`). */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * The first int of the two-int key: ASCII "Club". Any int4 would do, since no
 * other writer in this database uses the two-int form; a fixed, named value is
 * what lets a test (and anyone reading `pg_locks`) find it.
 */
export const CLUB_WRITE_LOCK_NAMESPACE = 0x436c7562;

/**
 * What a PUBLIC writer shows a person whose request still lost a deadlock (a
 * cycle through a writer that does not take this lock). Nothing was written —
 * the transaction rolled back — so trying again is safe and is the whole
 * remedy.
 */
export const CLUB_BUSY_MESSAGE =
	"This club is busy right now. Please try again in a moment.";

/**
 * Take the club write lock for the rest of this transaction. Blocks until it is
 * granted.
 *
 * MUST be called on a `tx`, not on `db`, and BEFORE the transaction's first row
 * lock: on the pooled client it would be taken and released on whatever
 * connection the pool handed out, and taken after a row lock it is too late to
 * order that row lock against anybody.
 */
export async function lockClubForWrite(tx: Tx, clubId: string): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(${CLUB_WRITE_LOCK_NAMESPACE}::int4, hashtext(${clubId}))`,
	);
}

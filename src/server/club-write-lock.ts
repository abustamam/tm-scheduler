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
 * | `openVote`                         | meeting FOR SHARE (frozen-status read), then  |
 * |                                    | meeting + club FOR SHARE, one statement       |
 * | `disqualifyCandidate`,             | meeting FOR SHARE (frozen-status read), no    |
 * | `undoDisqualification`             | club row lock, so they take no club lock      |
 * | `captureGuestVisit`                | club, then the meeting (attendance FK)        |
 * | `saveMeetingAgendaAsClubTemplate`  | meeting FOR UPDATE, then club NO KEY UPDATE   |
 *
 * so a guest checking in while another joins the ballot, or while an officer
 * saves that meeting's agenda as a template, was a Postgres 40P01. Two writers
 * take it for a different reason: `leaveFeedbackLogic` (its per-club caps)
 * and `collapseMemberships`, so a feedback note cannot land on a membership
 * mid-merge and be cascaded away by its DELETE. `mergePeople` takes every club
 * either Person holds, as a member OR as a guest (#1124), in id order, before it
 * locks a Person or writes anything. Writers that touch a guest's Person (a
 * convert, an undo, a link or unlink, a guest delete) take it before they lock
 * the Person, the first step of ADR-0031's lock protocol: club write lock, then
 * `people` rows `FOR UPDATE` in id order, then `guests` rows. Taking this
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
 * (`lockClubConverts`), `submitAccessRequestLogic`'s global
 * `access-requests:submit` key, the anonymous ballot's per-device
 * `ballot-anon:<session>:<device>` key (`castVote`, #982), and the per-member
 * `attendance:<meeting>:<member>` key (`lockMemberAttendance`) — so this one uses
 * the two-int form, with a
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
import { inArray, type SQL, sql } from "drizzle-orm";
import type { db } from "#/db";
import { people } from "#/db/schema";
import { isLockTimeout } from "./pg-errors";

/** A drizzle transaction handle (mirrors `mcp/lock.ts`). */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * The first int of the two-int key: ASCII "Club". Any int4 would do, since no
 * other writer in this database uses the two-int form; a fixed, named value is
 * what lets a test (and anyone reading `pg_locks`) find it.
 */
export const CLUB_WRITE_LOCK_NAMESPACE = 0x436c7562;

/**
 * What a PUBLIC writer shows a person whose request lost a deadlock (a cycle
 * through a writer that does not take this lock) or waited out
 * `CLUB_WRITE_LOCK_TIMEOUT` for this lock. Nothing was written — the
 * transaction rolled back — so trying again is safe and is the whole remedy.
 */
export const CLUB_BUSY_MESSAGE =
	"This club is busy right now. Please try again in a moment.";

/**
 * How long a writer waits for this lock before giving up, as a Postgres
 * interval. Mirrors `mcp/lock.ts`: `pg_advisory_xact_lock` otherwise blocks
 * INDEFINITELY while holding its pooled connection, and `src/db/index.ts` uses
 * node-postgres' default pool of 10 shared by the whole app — so a queue of
 * public check-ins behind one slow holder could starve every other request in
 * the process. The locked sections are a handful of statements, so 5s is well
 * beyond a real wait and well inside any request timeout.
 */
export const CLUB_WRITE_LOCK_TIMEOUT = "5s";

/**
 * Take the club write lock for the rest of this transaction. Blocks until it is
 * granted, for at most `timeout`; past that it throws `CLUB_BUSY_MESSAGE` with
 * the driver's 55P03 on `cause` (so a SQLSTATE check still sees it), for every
 * caller alike — officer paths included, which would otherwise show the
 * driver's `Failed query: …`.
 *
 * The timeout covers THIS wait only. It is set with `set_config(…, true)` (the
 * same scope as `SET LOCAL`) and the previous value is put back once the lock
 * is granted, so the row-lock waits after it keep exactly the patience they
 * had before #925 rather than inheriting a 5s limit nobody chose for them.
 *
 * MUST be called on a `tx`, not on `db`, and BEFORE the transaction's first row
 * lock: on the pooled client it would be taken and released on whatever
 * connection the pool handed out, and taken after a row lock it is too late to
 * order that row lock against anybody.
 *
 * `timeout` is a parameter only so a test can wait less than the production
 * value; every caller in `src/server` passes nothing.
 */
export async function lockClubForWrite(
	tx: Tx,
	clubId: string,
	timeout: string = CLUB_WRITE_LOCK_TIMEOUT,
): Promise<void> {
	await takeAdvisoryLockWithin(
		tx,
		sql`select pg_advisory_xact_lock(${CLUB_WRITE_LOCK_NAMESPACE}::int4, hashtext(${clubId}))`,
		timeout,
	);
}

/**
 * Run one `pg_advisory_xact_lock` statement bounded by `timeout`, then put the
 * transaction's own `lock_timeout` back — the mechanics `lockClubForWrite`
 * documents above, shared so a second app lock does not re-derive them. Past
 * the timeout it throws `CLUB_BUSY_MESSAGE` with the 55P03 on `cause`.
 */
export async function takeAdvisoryLockWithin(
	tx: Tx,
	lockStatement: SQL,
	timeout: string = CLUB_WRITE_LOCK_TIMEOUT,
): Promise<void> {
	const saved = await tx.execute<{ prev: string }>(
		sql`select current_setting('lock_timeout') as prev`,
	);
	const prev = saved.rows[0]?.prev ?? "0";
	await tx.execute(sql`select set_config('lock_timeout', ${timeout}, true)`);
	try {
		await tx.execute(lockStatement);
	} catch (err) {
		if (isLockTimeout(err)) throw new Error(CLUB_BUSY_MESSAGE, { cause: err });
		throw err;
	}
	await tx.execute(sql`select set_config('lock_timeout', ${prev}, true)`);
}

/**
 * Lock Persons in id order, the lock protocol's second step (#1124, ADR-0031).
 * Nulls and repeats are ignored. Returns what it locked.
 *
 * `mode` is the row-lock strength, and it is a decision, not a default to
 * forget. `"update"` (`FOR UPDATE`) conflicts with the key-share lock that every
 * foreign key INSERT takes on the row it names, so a path holding it blocks a
 * speech insert for that Person; take it only where the path deletes the Person
 * (a guest delete, a link, `mergePeople`). `"no key update"` conflicts with every
 * other writer of the row, `applyMemberEdit`'s `FOR UPDATE` included, and NOT
 * with a key share, so it orders the Person against its writers without
 * blocking the claim that inserts a speech for it. Taking `FOR UPDATE` on a
 * Person while waiting for a membership or a slot closed a cycle with
 * `claimSlotCore`, which holds the slot, then takes the key share while it
 * inserts the speech.
 */
export async function lockPersonsInOrder(
	tx: Tx,
	personIds: Array<string | null | undefined>,
	mode: "update" | "no key update" = "update",
): Promise<string[]> {
	const ids = [...new Set(personIds.filter((id): id is string => !!id))];
	if (ids.length === 0) return [];
	const rows = await tx
		.select({ id: people.id })
		.from(people)
		.where(inArray(people.id, ids))
		.orderBy(people.id)
		.for(mode);
	return rows.map((r) => r.id);
}

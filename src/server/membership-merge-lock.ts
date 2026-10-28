/**
 * The membership merge lock (#1035): ONE transaction-scoped advisory lock per
 * membership, taken EXCLUSIVE by the merge that absorbs it and SHARED by every
 * writer this lock covers that is about to make a row reference it.
 *
 * Why it exists. `collapseMemberships` re-points each foreign key that names
 * the absorbed membership, then DELETEs it. A writer that inserts or updates a
 * row naming the absorbed membership after its re-point has run, and commits
 * before the DELETE, is not re-pointed: the DELETE waits on the writer's FK
 * lock, then `on delete set null` takes the reference away. Two writers did
 * exactly that:
 *
 * - `claimSlotCore` left the slot `claimed` with no holder, which no later
 *   claim can take (claims require `status = 'open'`);
 * - `castVote` left an identified ballot (`anonymous = false`) with no voter,
 *   counted beside the keeper's own ballot: one person, two votes.
 *
 * With this lock a covered writer either finishes before the merge's first
 * re-point (and is re-pointed with everything else) or starts after the merge
 * has committed, finds the membership gone, and is refused with
 * `CLUB_BUSY_MESSAGE` before it writes anything.
 *
 * Why not `FOR UPDATE` on the membership row, which would cover every writer
 * at once: #1031 tried that and backed it out. A slot reassignment locks the
 * slot then FK-locks its new holder, while the merge would lock the holder then
 * update the slot; a ballot cast holds its session `FOR SHARE` then FK-locks
 * the voter, while the merge updates the session's opener. Both deadlock.
 *
 * LOCK ORDER. Every taker takes this lock BEFORE its first row lock:
 *
 *   merge:  club write lock → THIS (exclusive, keeper and absorbed ids, in
 *           lock-key order) → Persons → member rows → slots (slot-id order)
 *   writer: [club write lock →] THIS (shared, each referenced member id, in
 *           lock-key order) → row locks
 *
 * Most covered writers take no club write lock. Two do, and take it FIRST, as
 * the merge does: `setMentorshipFocus` and `applyUnlinkGuestFromMember` (#1217),
 * so the club → member order is still never reversed. Undo of a guest
 * conversion (`applyUndoGuestConversion`, #1217) takes the EXCLUSIVE half as a
 * member removal does, because it deletes the membership; it is not a merge, and
 * its order is club write lock → THIS (exclusive) → Persons → guest row. A
 * writer holds nothing (or only the club write lock) when it waits here, so it
 * cannot be part of a cycle through the merge; the merge holds only advisory
 * locks when it waits here (inside `mergePeople`, also the Person rows and the
 * row locks of the clubs it has already collapsed — none of which a writer
 * covered here touches, except that a SPEAKER claim's speech FK-locks the
 * Person row: that pair already deadlocked before this lock, since the claim
 * then held the membership's FK lock that the DELETE needs). Shared takers
 * never block each other, so the room does not queue behind itself.
 *
 * THE KEY SPACE. The two-int form, like `lockClubForWrite`, with its own fixed
 * namespace as the first int, so it can never equal the club write lock's key
 * or any bigint-keyed lock in the app. Two memberships whose ids share a
 * `hashtext` value share a key, which costs only a brief wait.
 *
 * ORDER OF SEVERAL LOCKS. A taker of more than one membership lock takes them
 * in ascending order of the KEY (the `hashtext` value), never of the id text,
 * and takes a key shared by two ids once. `hashtext` is not injective and does
 * not preserve text order, so ordering by id can invert two takers: with ids
 * a < b < c and hashtext(a) = hashtext(c), a ballot takes S(a) then S(b) while
 * a merge (keeper b, absorbed c) sorted by id takes X(b) then X(c), which is
 * the key of a: each waits on the other, 40P01. Ordered by key, both take the
 * smaller key first.
 *
 * Waits are bounded by `takeAdvisoryLockWithin` (5s, then `CLUB_BUSY_MESSAGE`),
 * because a public writer waiting here holds a pooled connection.
 */
import { inArray, sql } from "drizzle-orm";
import type { db } from "#/db";
import { members } from "#/db/schema";
import { CLUB_BUSY_MESSAGE, takeAdvisoryLockWithin } from "./club-write-lock";

/** A drizzle transaction handle (mirrors `club-write-lock.ts`). */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** The first int of the two-int key: ASCII "Memb". */
export const MEMBERSHIP_MERGE_LOCK_NAMESPACE = 0x4d656d62;

/**
 * The text a membership id is hashed as. Lowercased, because the key is a hash
 * of TEXT while the id is a `uuid`: Postgres resolves `ABC…` and `abc…` to the
 * same membership, and the zod `uuid()` validators on the public claim and
 * ballot endpoints accept either case unchanged. Hashing the raw input would
 * give an uppercase id a different key from the merge's, and that writer would
 * skip the lock entirely. Both halves go through this, so they always agree.
 */
export function membershipLockKey(memberId: string): string {
	return memberId.toLowerCase();
}

/**
 * The merge's half: take the absorbed membership's lock EXCLUSIVE, so no
 * covered writer is mid-way through referencing it while the merge re-points,
 * and none can start until the merge commits. MUST be on a `tx`, before the
 * merge's first row lock.
 */
export async function lockMembershipForMerge(
	tx: Tx,
	absorbedMemberId: string,
): Promise<void> {
	await takeAdvisoryLockWithin(
		tx,
		sql`select pg_advisory_xact_lock(${MEMBERSHIP_MERGE_LOCK_NAMESPACE}::int4, hashtext(${membershipLockKey(absorbedMemberId)}))`,
	);
}

/**
 * The distinct lock keys of these ids, ascending. Computed by Postgres so the
 * order is exactly the one `hashtext` yields for the lock call. A JS array is
 * wrapped in `sql.param`, or drizzle expands it per element.
 */
async function lockKeysInOrder(
	tx: Tx,
	memberIds: ReadonlyArray<string>,
): Promise<number[]> {
	const res = await tx.execute(
		sql`select distinct hashtext(k) as h from unnest(${sql.param(memberIds.map(membershipLockKey))}::text[]) as k order by h`,
	);
	return res.rows.map((r) => Number((r as { h: number | string }).h));
}

/**
 * The merge's half for several memberships (the keeper and the absorbed): take
 * each lock EXCLUSIVE, in ascending lock-key order (see ORDER OF SEVERAL LOCKS
 * above). Same placement rule as `lockMembershipForMerge`.
 */
export async function lockMembershipsForMerge(
	tx: Tx,
	memberIds: ReadonlyArray<string>,
): Promise<void> {
	if (memberIds.length === 0) return;
	for (const h of await lockKeysInOrder(tx, memberIds)) {
		await takeAdvisoryLockWithin(
			tx,
			sql`select pg_advisory_xact_lock(${MEMBERSHIP_MERGE_LOCK_NAMESPACE}::int4, ${h}::int4)`,
		);
	}
}

/**
 * A writer's half: take each membership's lock SHARED, in lock-key order, then
 * re-read that every one still exists. A membership a merge absorbed while the
 * writer waited is gone, and the writer is refused with `CLUB_BUSY_MESSAGE`
 * before it writes anything; trying again after a reload finds the keeper.
 * MUST be on a `tx`, before the writer's first row lock. Nulls are skipped,
 * so a caller can pass an optional reference as it stands.
 */
export async function lockMembershipsAgainstMerge(
	tx: Tx,
	memberIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
	const ids = [
		...new Set(
			memberIds
				.filter((id): id is string => Boolean(id))
				.map(membershipLockKey),
		),
	];
	if (ids.length === 0) return;
	for (const h of await lockKeysInOrder(tx, ids)) {
		await takeAdvisoryLockWithin(
			tx,
			sql`select pg_advisory_xact_lock_shared(${MEMBERSHIP_MERGE_LOCK_NAMESPACE}::int4, ${h}::int4)`,
		);
	}
	const found = await tx
		.select({ id: members.id })
		.from(members)
		.where(inArray(members.id, ids));
	if (found.length !== ids.length) throw new Error(CLUB_BUSY_MESSAGE);
}

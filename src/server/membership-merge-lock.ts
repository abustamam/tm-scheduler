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
 *   merge:  club write lock → THIS (exclusive, absorbed id) → row locks
 *   writer: THIS (shared, each referenced member id, in id order) → row locks
 *
 * No covered writer takes the club write lock, so the merge's club → member
 * order is never reversed. A writer holds nothing when it waits here, so it
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
		sql`select pg_advisory_xact_lock(${MEMBERSHIP_MERGE_LOCK_NAMESPACE}::int4, hashtext(${absorbedMemberId}))`,
	);
}

/**
 * A writer's half: take each membership's lock SHARED, in id order, then
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
		...new Set(memberIds.filter((id): id is string => Boolean(id))),
	].sort();
	if (ids.length === 0) return;
	for (const id of ids) {
		await takeAdvisoryLockWithin(
			tx,
			sql`select pg_advisory_xact_lock_shared(${MEMBERSHIP_MERGE_LOCK_NAMESPACE}::int4, hashtext(${id}))`,
		);
	}
	const found = await tx
		.select({ id: members.id })
		.from(members)
		.where(inArray(members.id, ids));
	if (found.length !== ids.length) throw new Error(CLUB_BUSY_MESSAGE);
}

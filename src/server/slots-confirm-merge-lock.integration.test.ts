/**
 * `confirmSlotCore`'s self arm against a membership merge (#1344), driven on
 * real connections.
 *
 * The self arm writes two rows that name the holder, the plan row and the
 * activity row, after taking the slot's row lock. A merge absorbing that
 * holder re-points the plan row BEFORE it re-points the slot
 * (`collapseMemberships`), so a confirm that held the slot and wanted the plan
 * row could meet a merge that held the plan row and wanted the slot: a cycle
 * Postgres resolves by aborting one of the two. The membership merge lock
 * (#1035, `membership-merge-lock.ts`) breaks it, but only for a writer that
 * takes it FIRST, in the documented order:
 *
 *   merge lock (shared) -> attendance lock -> row locks
 *
 * so this file pins three things the confirm must do, each by an interleaving
 * that goes red when the lock is gone:
 *
 * - the merge lock comes BEFORE the attendance lock (a probe from a third
 *   connection finds the attendance key still free while the confirm waits on
 *   the merge lock);
 * - a confirm already in flight makes the merge WAIT, so its rows are there to
 *   re-point, and neither side deadlocks;
 * - a confirm that arrives while the merge is mid-way is refused with
 *   `CLUB_BUSY_MESSAGE` once the membership is gone, writing nothing.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetingAttendancePlan, members, roleSlots } from "#/db/schema";
import type { WriteProof } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { collapseMemberships } = await import("./membership-collapse-logic");
const { confirmSlotCore } = await import("./slots-logic");
const { memberAttendanceLockKey } = await import("./attendance-plan-logic");
const { lockMembershipForMerge } = await import("./membership-merge-lock");
const { CLUB_BUSY_MESSAGE } = await import("./club-write-lock");

/** How long a wait for a parked statement may take before the test calls it. */
const PARK_MS = 5_000;

/**
 * Every merge and confirm a test starts. A test that fails part-way leaves them
 * parked behind its holds, so `afterEach` releases the holds and then waits for
 * these to settle before it deletes the club out from under them.
 */
const inFlight: Promise<unknown>[] = [];
const openHolds: Array<{ commit: () => Promise<void> }> = [];

function track<T>(p: Promise<T>): Promise<T> {
	p.catch(() => {});
	inFlight.push(p);
	return p;
}

async function openHold(work: Parameters<typeof openBlockingTx>[0]) {
	const h = await openBlockingTx(work);
	openHolds.push(h);
	return h;
}

const outcome = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: unknown) => (e instanceof Error ? e.message : String(e)),
	);

describe.skipIf(!hasTestDb)(
	"confirmSlotCore vs a membership merge (#1344)",
	() => {
		let seed: SeededClub;
		let keeperId: string;
		let absorbedId: string;

		beforeEach(async () => {
			seed = await seedClub();
			keeperId = seed.memberId;
			const personId = await seedPerson({
				name: `Absorbed ${crypto.randomUUID()}`,
			});
			const [row] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId,
					name: "Absorbed Duplicate",
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			if (!row) throw new Error("Failed to insert the absorbed member");
			absorbedId = row.id;
			// The absorbed member holds the role, claimed, and the officer has asked
			// them: an EXISTING plan row, so the confirm's plan write is an UPDATE
			// of a row the merge also re-points, which is the cycle's shape.
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: absorbedId,
					status: "claimed",
					claimedAt: new Date(),
				})
				.where(eq(roleSlots.id, seed.slotId));
			await testDb.insert(meetingAttendancePlan).values({
				memberId: absorbedId,
				meetingId: seed.meetingId,
				status: "reached_out",
			});
		});

		afterEach(async () => {
			for (const h of openHolds.splice(0)) await h.commit().catch(() => {});
			await Promise.allSettled(inFlight.splice(0));
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		/** Run the merge on its own connection; resolves its backend pid first. */
		function startMerge() {
			let gotPid!: (pid: number) => void;
			const pid = new Promise<number>((r) => {
				gotPid = r;
			});
			const done = testDb.transaction(async (tx) => {
				const res = await tx.execute(sql`select pg_backend_pid() as pid`);
				gotPid(Number((res.rows[0] as { pid: number }).pid));
				await collapseMemberships(tx, seed.clubId, keeperId, absorbedId);
			});
			return { pid, done: track(done) };
		}

		const confirmAs = (proof: WriteProof) =>
			track(
				confirmSlotCore({
					slotId: seed.slotId,
					sessionUserId: null,
					selfMemberId: absorbedId,
					proof,
				}),
			);

		const readSlot = async () =>
			(
				await testDb
					.select({
						status: roleSlots.status,
						assignedMemberId: roleSlots.assignedMemberId,
					})
					.from(roleSlots)
					.where(eq(roleSlots.id, seed.slotId))
			)[0];

		const planOf = async (memberId: string) =>
			(
				await testDb
					.select({ status: meetingAttendancePlan.status })
					.from(meetingAttendancePlan)
					.where(
						and(
							eq(meetingAttendancePlan.memberId, memberId),
							eq(meetingAttendancePlan.meetingId, seed.meetingId),
						),
					)
			)[0]?.status ?? null;

		it("an asserted confirm takes the merge lock BEFORE the attendance lock", async () => {
			// protects=the documented order merge lock -> attendance lock -> rows, for the one writer that takes the attendance lock without a session; fails_when=the merge lock is dropped (the confirm never parks on it) or taken AFTER the attendance lock (the probe below finds the key held); no_claim=a three-way cycle through a second writer is not driven, only the order that rules it out
			const merge = await openHold((tx) =>
				lockMembershipForMerge(tx, absorbedId),
			);
			const confirm = confirmAs("asserted");
			const confirmPid = await waitForLockWait(
				"pg_advisory_xact_lock_shared",
				merge.pid,
				PARK_MS,
			);
			expect(confirmPid).toBeGreaterThan(0);

			// The confirm is parked on the merge lock. If it already held the
			// attendance lock, a try-lock on that key from here would fail.
			const probe = await testDb.transaction(async (tx) => {
				const res = await tx.execute(
					sql`select pg_try_advisory_xact_lock(hashtextextended(${memberAttendanceLockKey(seed.meetingId, absorbedId)}, 0)) as got`,
				);
				return (res.rows[0] as { got: boolean }).got;
			});
			expect(probe).toBe(true);

			await merge.commit();
			await confirm;
			expect((await readSlot())?.status).toBe("confirmed");
			expect(await planOf(absorbedId)).toBe("coming");
		});

		it.each([
			"asserted",
			"session",
		] as const)("a %s confirm already in flight makes the merge wait, lands on the keeper, and neither deadlocks", async (proof) => {
			// protects=a confirm that holds the slot's row lock is never in a lock cycle with a merge that re-points the plan row first, and its two rows are re-pointed rather than orphaned; fails_when=the confirm takes no merge lock, so the merge never parks on it; no_claim=the deadlock itself is not forced (Postgres aborts one side after its timeout), only the lock that rules it out
			// Park the confirm on its slot UPDATE, after it has taken its locks.
			const hold = await openHold(async (tx) => {
				await tx.execute(
					sql`select 1 from role_slots where id = ${seed.slotId} for update`,
				);
			});
			const confirm = confirmAs(proof);
			const confirmPid = await waitForLockWait(
				'update "role_slots"',
				hold.pid,
				PARK_MS,
			);

			const merge = startMerge();
			// The merge parks on the confirm's shared merge lock, not on a row.
			await waitForLockWait("pg_advisory_xact_lock", confirmPid, PARK_MS);

			await hold.commit();
			await confirm;
			await merge.done;

			const slot = await readSlot();
			expect(slot).toEqual({ status: "confirmed", assignedMemberId: keeperId });
			// The confirm's plan write was re-pointed with everything else.
			expect(await planOf(keeperId)).toBe("coming");
			expect(await planOf(absorbedId)).toBeNull();
		});

		it.each([
			"asserted",
			"session",
		] as const)("a %s confirm arriving mid-merge is refused once the membership is gone, and writes nothing", async (proof) => {
			// protects=a confirm resolved against the absorbed holder cannot land a plan row or a status flip after the merge re-pointed; fails_when=the confirm takes no merge lock (it parks on the merge's row lock instead and is refused with the wrong message); no_claim=the keeper's own view of the role after the merge is the merge's own test
			// Park the merge on its DELETE, past every re-point.
			const hold = await openHold(async (tx) => {
				await tx.execute(
					sql`select 1 from members where id = ${absorbedId} for key share`,
				);
			});
			const merge = startMerge();
			await waitForLockWait('delete from "members"', hold.pid, PARK_MS);
			const mergePid = await merge.pid;

			// The slot it reads is the committed one: still the absorbed holder's.
			const confirm = confirmAs(proof);
			const result = outcome(confirm);
			await waitForLockWait("pg_advisory_xact_lock_shared", mergePid, PARK_MS);

			await hold.commit();
			await merge.done;

			expect(await result).toBe(CLUB_BUSY_MESSAGE);
			// The role is the keeper's and still `claimed`: the confirm flipped
			// nothing, and the officer's ask is the keeper's, not turned into `coming`.
			expect(await readSlot()).toEqual({
				status: "claimed",
				assignedMemberId: keeperId,
			});
			expect(await planOf(keeperId)).toBe("reached_out");
		});
	},
);

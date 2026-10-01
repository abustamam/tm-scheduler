/**
 * `applyMemberEdit` and `applyConvertGuestToMember` take the same two row locks
 * — the Person and the membership — and must take them in the SAME order, or
 * the two deadlock (#906 review). Convert writes the Person first (its phone
 * fill and its goes-by seed) and then selects the membership `FOR UPDATE`; the
 * edit used to update the membership first and the Person second.
 *
 * Driven deterministically on two connections:
 *   1. A "convert-shaped" transaction takes the Person row lock, exactly as
 *      convert's `update people` does, and parks.
 *   2. `applyMemberEdit` starts, and the test waits until it is provably
 *      blocked BY that transaction (`waitForLockWait` reads the lock graph).
 *   3. The convert-shaped transaction then takes the membership `FOR UPDATE`,
 *      convert's second lock.
 * With Person-then-membership in the edit, step 2 blocks on the Person before
 * the edit has touched the membership, so step 3 proceeds and both commit. With
 * the old order the edit already holds the membership at step 2, step 3 waits
 * on it, and Postgres aborts one side with 40P01 after `deadlock_timeout`.
 *
 * The convert half is a stand-in, not the real function: there is no seam to
 * pause `applyConvertGuestToMember` between its two locks. It issues the same
 * two statements in the same order, which is the property under test.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMemberEdit } = await import("./members-logic");

function pgCode(reason: unknown): string | undefined {
	const e = reason as { code?: string; cause?: { code?: string } };
	return e?.code ?? e?.cause?.code;
}

describe.skipIf(!hasTestDb)("edit and convert lock in one order (#906)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("an edit racing a convert on the same member does not deadlock", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let holding!: (pid: number) => void;
		const holderPid = new Promise<number>((r) => {
			holding = r;
		});

		const convertLike = testDb.transaction(async (tx) => {
			const res = await tx.execute(sql`select pg_backend_pid() as pid`);
			// Convert's FIRST lock: its write to the Person.
			await tx.execute(
				sql`update people set phone = phone where id = ${seed.personId}`,
			);
			holding(Number((res.rows[0] as { pid: number }).pid));
			await gate;
			// Convert's SECOND lock: the membership, `FOR UPDATE`.
			await tx.execute(
				sql`select id from members where id = ${seed.memberId} for update`,
			);
		});
		convertLike.catch(() => {});
		const pid = await holderPid;

		const next = `+1415${String(Date.now() % 10_000_000).padStart(7, "0")}`;
		const editing = applyMemberEdit({
			clubId: seed.clubId,
			memberId: seed.memberId,
			actorMemberId: seed.adminMemberId,
			name: "Member User",
			email: `member-${seed.memberUserId}@test.example`,
			phone: next,
		});
		editing.catch(() => {});

		// The edit is parked behind the convert's Person lock — on whichever
		// statement touches `people` first.
		await waitForLockWait('"people"', pid);
		release();

		const [c, e] = await Promise.allSettled([convertLike, editing]);
		const codes = [c, e]
			.filter((r) => r.status === "rejected")
			.map((r) => pgCode((r as PromiseRejectedResult).reason));
		expect(codes, "a deadlock (40P01) means the lock orders differ").toEqual(
			[],
		);

		const [p] = await testDb
			.select({ phone: people.phone })
			.from(people)
			.where(eq(people.id, seed.personId));
		expect(p?.phone).toBe(next);
	}, 20_000);
});

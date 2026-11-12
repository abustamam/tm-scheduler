/**
 * #1611: a guest merge must not deadlock (40P01) with a writer that locks a
 * slot or a vote row FIRST and key-shares a guest SECOND. Each test holds the
 * writer's first lock, waits until the merge is provably blocked behind it,
 * then lets the writer take its guest key share. No timing luck: with the
 * merge's old order (guest rows first) the writer's key share and the merge's
 * row wait close a cycle every run.
 *
 * Every test states its card: protects=…; fails_when=…; no_claim=….
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingVoteSessions,
	meetingVotes,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMergeGuests } = await import("#/server/guest-merge-logic");
const { lockSpeakerSlotForDetails } = await import("#/server/slots-logic");

async function waitUntilBlockedBy(writerPid: number): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const rows = await testDb.execute(
			sql`select 1 from pg_stat_activity where ${writerPid} = any(pg_blocking_pids(pid))`,
		);
		if (rows.rows.length > 0) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("the merge never blocked behind the writer");
}

describe.skipIf(!hasTestDb)("guest merge lock order (#1611)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function mkGuest(name: string) {
		const [g] = await testDb
			.insert(guests)
			.values(await withGuestPerson({ clubId: seed.clubId, name }, testDb))
			.returning({ id: guests.id });
		if (!g) throw new Error("seed guest failed");
		return g.id;
	}

	const input = (keep: string, absorb: string) => ({
		clubId: seed.clubId,
		keepGuestId: keep,
		absorbGuestId: absorb,
		actorUserId: seed.adminUserId,
	});

	// protects=a merge racing a speech-detail save on the absorbed guest's slot
	// fails_when=the merge locks the guest rows before the slot (40P01)
	// no_claim=does not cover the delete-guest path
	it("a speech-detail save on the absorbed guest's slot and the merge both complete", async () => {
		const keep = await mkGuest("Keeper");
		const absorb = await mkGuest("Absorbed");
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: absorb, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));

		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let mergeP!: Promise<unknown>;
		const writer = testDb.transaction(async (tx) => {
			await lockSpeakerSlotForDetails(tx, {
				meetingId: seed.meetingId,
				slotId: seed.slotId,
			});
			const pidRes = await tx.execute(sql`select pg_backend_pid() as pid`);
			const pid = Number((pidRes.rows[0] as { pid: number }).pid);
			mergeP = applyMergeGuests(input(keep, absorb));
			mergeP.catch(() => {});
			await waitUntilBlockedBy(pid);
			// The speech insert's FK check key-shares the absorbed guest.
			const [sp] = await tx
				.insert(speeches)
				.values({ guestId: absorb, title: "Ice Breaker" })
				.returning({ id: speeches.id });
			await tx
				.update(roleSlots)
				.set({ speechId: sp?.id })
				.where(eq(roleSlots.id, seed.slotId));
			release();
		});
		await gate;
		await writer;
		await expect(mergeP).resolves.toMatchObject({ refusal: null });

		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId));
		expect(slot?.assignedGuestId).toBe(keep);
		const [speech] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, slot?.speechId ?? ""));
		expect(speech?.guestId).toBe(keep);
	});

	// protects=a merge racing an anonymous re-vote that moves a ballot from the
	//   absorbed guest to the keeper
	// fails_when=the merge locks the guest rows before the vote rows (40P01)
	// no_claim=does not cover the identified-voter arm
	it("an anonymous re-vote from the absorbed guest to the keeper and the merge both complete", async () => {
		const keep = await mkGuest("Keeper");
		const absorb = await mkGuest("Absorbed");
		const [session] = await testDb
			.insert(meetingVoteSessions)
			.values({ meetingId: seed.meetingId, category: "best_speaker" })
			.returning({ id: meetingVoteSessions.id });
		if (!session) throw new Error("seed session failed");
		const [vote] = await testDb
			.insert(meetingVotes)
			.values({
				sessionId: session.id,
				anonymous: true,
				deviceToken: "device-1611",
				candidateGuestId: absorb,
			})
			.returning({ id: meetingVotes.id });
		if (!vote) throw new Error("seed vote failed");

		let mergeP!: Promise<unknown>;
		await testDb.transaction(async (tx) => {
			await tx
				.select({ id: meetingVotes.id })
				.from(meetingVotes)
				.where(eq(meetingVotes.id, vote.id))
				.for("update");
			const pidRes = await tx.execute(sql`select pg_backend_pid() as pid`);
			const pid = Number((pidRes.rows[0] as { pid: number }).pid);
			mergeP = applyMergeGuests(input(keep, absorb));
			mergeP.catch(() => {});
			await waitUntilBlockedBy(pid);
			// The re-vote's FK check key-shares the keeper.
			await tx
				.update(meetingVotes)
				.set({ candidateGuestId: keep })
				.where(eq(meetingVotes.id, vote.id));
		});
		await expect(mergeP).resolves.toMatchObject({ refusal: null });

		const [after] = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.id, vote.id));
		expect(after?.candidateGuestId).toBe(keep);
	});
});

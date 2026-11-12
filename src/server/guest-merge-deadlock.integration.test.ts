/**
 * #1611: a guest merge and a guest delete must not deadlock (40P01) with a
 * writer that locks a slot or a vote row FIRST and key-shares a guest SECOND.
 * Each test holds the writer's first lock, waits until the path under test is
 * provably blocked behind it (`waitForLockWait`, the lock graph, not a sleep),
 * then lets the writer take its guest key share. No timing luck: with the old
 * order (guest row first) the key share and the path's row wait close a cycle
 * every run, and the failure is the 40P01 itself, not a timeout.
 *
 * Why the writers are hand-driven inside a held transaction rather than the
 * real server functions: `castVote` / `castAnonymousVote` open their own
 * `db.transaction` (not injectable), so a test cannot hold their locks across a
 * wait. The slot side does use the real `lockSpeakerSlotForDetails` and
 * `attachSpeechToSlot`, the same two calls the speech-detail save makes.
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
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMergeGuests } = await import("#/server/guest-merge-logic");
const { applyDeleteGuest, GUEST_HAS_SPEECHES_MESSAGE } = await import(
	"#/server/guest-pipeline-logic"
);
const { attachSpeechToSlot, lockSpeakerSlotForDetails } = await import(
	"#/server/slots-logic"
);

type Tx = Parameters<Parameters<typeof testDb.transaction>[0]>[0];

async function pidOf(tx: Tx): Promise<number> {
	const res = await tx.execute(sql`select pg_backend_pid() as pid`);
	return Number((res.rows[0] as { pid: number }).pid);
}

describe.skipIf(!hasTestDb)("guest merge / delete lock order (#1611)", () => {
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

	async function mkSession() {
		const [existing] = await testDb
			.select({ id: meetingVoteSessions.id })
			.from(meetingVoteSessions)
			.where(eq(meetingVoteSessions.meetingId, seed.meetingId));
		if (existing) return existing.id;
		const [session] = await testDb
			.insert(meetingVoteSessions)
			.values({ meetingId: seed.meetingId, category: "best_speaker" })
			.returning({ id: meetingVoteSessions.id });
		if (!session) throw new Error("seed session failed");
		return session.id;
	}

	async function mkVote(values: Partial<typeof meetingVotes.$inferInsert>) {
		const [vote] = await testDb
			.insert(meetingVotes)
			.values({ sessionId: await mkSession(), ...values })
			.returning({ id: meetingVotes.id });
		if (!vote) throw new Error("seed vote failed");
		return vote.id;
	}

	const mergeInput = (keep: string, absorb: string) => ({
		clubId: seed.clubId,
		keepGuestId: keep,
		absorbGuestId: absorb,
		actorUserId: seed.adminUserId,
	});

	async function holdSlot(guestId: string) {
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: guestId, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
	}

	/** The speech-detail save's first two moves, then the speech insert (the
	 *  FK check key-shares the guest) while `contender` is blocked behind it. */
	async function speechSaveWhile(
		guestId: string,
		startContender: () => Promise<unknown>,
	) {
		await testDb.transaction(async (tx) => {
			await lockSpeakerSlotForDetails(tx, {
				meetingId: seed.meetingId,
				slotId: seed.slotId,
			});
			const pid = await pidOf(tx);
			const contender = startContender();
			contender.catch(() => {});
			await waitForLockWait("role_slots", pid);
			await attachSpeechToSlot(tx, {
				slotId: seed.slotId,
				guestId,
				input: { speechTitle: "Ice Breaker" },
			});
		});
	}

	// protects=a merge racing a speech-detail save on the absorbed guest's slot
	// fails_when=the merge locks the guest rows before the slot (40P01)
	// no_claim=does not cover the delete path (below)
	it("a speech-detail save on the absorbed guest's slot and the merge both complete", async () => {
		const keep = await mkGuest("Keeper");
		const absorb = await mkGuest("Absorbed");
		await holdSlot(absorb);

		let mergeP!: Promise<unknown>;
		await speechSaveWhile(absorb, () => {
			mergeP = applyMergeGuests(mergeInput(keep, absorb));
			return mergeP;
		});
		await expect(mergeP).resolves.toMatchObject({ refusal: null });

		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId));
		expect(slot?.assignedGuestId).toBe(keep);
		const speech = await testDb.query.speeches.findFirst({
			where: (s, { eq: e }) => e(s.id, slot?.speechId ?? ""),
		});
		expect(speech?.guestId).toBe(keep);
	});

	// protects=a guest delete racing a speech-detail save on the guest's slot
	// fails_when=the delete locks the guest row before the slot (40P01)
	// no_claim=says nothing about the refusal's wording beyond the speech rule
	it("a speech-detail save and a delete of the same guest end in the speech refusal, not a deadlock", async () => {
		const guest = await mkGuest("Soon speaking");
		await holdSlot(guest);

		let deleteP!: Promise<unknown>;
		await speechSaveWhile(guest, () => {
			deleteP = applyDeleteGuest({
				clubId: seed.clubId,
				guestId: guest,
				actorMemberId: seed.adminMemberId,
			});
			return deleteP;
		});
		// The speech committed first; the delete then re-reads and refuses.
		await expect(deleteP).rejects.toThrow(GUEST_HAS_SPEECHES_MESSAGE);
		const [still] = await testDb
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.id, guest));
		expect(still?.id).toBe(guest);
	});

	// protects=a merge racing an anonymous re-vote that moves a ballot off the
	//   absorbed guest; the bystander ballot proves the merge re-pointed votes
	// fails_when=the merge locks the guest rows before the vote rows (40P01)
	// no_claim=the writer is hand-driven (castAnonymousVote opens its own
	//   transaction); the re-vote can only deadlock when it moves to ANOTHER guest
	it("an anonymous re-vote off the absorbed guest and the merge both complete", async () => {
		const keep = await mkGuest("Keeper");
		const absorb = await mkGuest("Absorbed");
		const moving = await mkVote({
			anonymous: true,
			deviceToken: "device-moving",
			candidateGuestId: absorb,
		});
		const bystander = await mkVote({
			anonymous: true,
			deviceToken: "device-bystander",
			candidateGuestId: absorb,
		});

		let mergeP!: Promise<unknown>;
		await testDb.transaction(async (tx) => {
			await tx
				.select({ id: meetingVotes.id })
				.from(meetingVotes)
				.where(eq(meetingVotes.id, moving))
				.for("update");
			const pid = await pidOf(tx);
			mergeP = applyMergeGuests(mergeInput(keep, absorb));
			mergeP.catch(() => {});
			await waitForLockWait("meeting_votes", pid);
			// The re-vote's FK check key-shares the keeper.
			await tx
				.update(meetingVotes)
				.set({ candidateGuestId: keep })
				.where(eq(meetingVotes.id, moving));
		});
		await expect(mergeP).resolves.toMatchObject({ refusal: null });

		const [after] = await testDb
			.select({ id: meetingVotes.id, c: meetingVotes.candidateGuestId })
			.from(meetingVotes)
			.where(eq(meetingVotes.id, bystander));
		expect(after?.c).toBe(keep);
	});

	// protects=the voter_guest_id arm of the vote pre-lock (merge)
	// fails_when=the pre-lock names only candidate_guest_id (40P01)
	// no_claim=does not cover the candidate arm (test above)
	it("a vote cast BY the absorbed guest that is being changed and the merge both complete", async () => {
		const keep = await mkGuest("Keeper");
		const absorb = await mkGuest("Absorbed");
		const vote = await mkVote({
			voterGuestId: absorb,
			candidateWriteIn: "Zed",
		});

		let mergeP!: Promise<unknown>;
		await testDb.transaction(async (tx) => {
			await tx
				.select({ id: meetingVotes.id })
				.from(meetingVotes)
				.where(eq(meetingVotes.id, vote))
				.for("update");
			const pid = await pidOf(tx);
			mergeP = applyMergeGuests(mergeInput(keep, absorb));
			mergeP.catch(() => {});
			await waitForLockWait("meeting_votes", pid);
			await tx
				.update(meetingVotes)
				.set({ candidateWriteIn: null, candidateGuestId: keep })
				.where(eq(meetingVotes.id, vote));
		});
		await expect(mergeP).resolves.toMatchObject({ refusal: null });

		const [after] = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.id, vote));
		expect(after?.voterGuestId).toBe(keep);
		expect(after?.candidateGuestId).toBe(keep);
	});

	// protects=a guest delete whose cascade would lock a vote row after the guest
	// fails_when=the delete locks the guest row before the vote rows (40P01)
	// no_claim=the writer's change (a self-vote) is contrived at the row level; it
	//   is the one shape in which a vote writer key-shares the guest being deleted
	it("a vote cast by the deleted guest that is being changed and the delete both complete", async () => {
		const guest = await mkGuest("Deleted");
		const vote = await mkVote({
			voterGuestId: guest,
			candidateWriteIn: "Zed",
		});

		let deleteP!: Promise<unknown>;
		await testDb.transaction(async (tx) => {
			await tx
				.select({ id: meetingVotes.id })
				.from(meetingVotes)
				.where(eq(meetingVotes.id, vote))
				.for("update");
			const pid = await pidOf(tx);
			deleteP = applyDeleteGuest({
				clubId: seed.clubId,
				guestId: guest,
				actorMemberId: seed.adminMemberId,
			});
			deleteP.catch(() => {});
			await waitForLockWait("meeting_votes", pid);
			await tx
				.update(meetingVotes)
				.set({ candidateWriteIn: null, candidateGuestId: guest })
				.where(eq(meetingVotes.id, vote));
		});
		await expect(deleteP).resolves.toBeDefined();
		const gone = await testDb
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.id, guest));
		expect(gone).toHaveLength(0);
	});

	// protects=the slot pre-lock is FOR NO KEY UPDATE: an evaluator move holds
	//   the evaluator slot and key-shares the speaker slot (self-FK)
	// fails_when=the pre-lock is FOR UPDATE on the speaker slot (40P01), with
	//   the speaker slot's id sorting before the evaluator slot's
	// no_claim=the writer is the row-level shape of `realignEvaluatorPairs`, not
	//   the function
	it("an evaluator realign on the absorbed guest's slots and the merge both complete", async () => {
		const keep = await mkGuest("Keeper");
		const absorb = await mkGuest("Absorbed");
		const made = await testDb
			.insert(roleSlots)
			.values(
				[0, 1].map((i) => ({
					meetingId: seed.meetingId,
					roleDefinitionId: seed.roleDefinitionId,
					slotIndex: i + 5,
					assignedGuestId: absorb,
					status: "claimed" as const,
				})),
			)
			.returning({ id: roleSlots.id });
		const [speakerSlot, evaluatorSlot] = made.map((r) => r.id).sort();
		if (!speakerSlot || !evaluatorSlot) throw new Error("seed slots failed");

		let mergeP!: Promise<unknown>;
		await testDb.transaction(async (tx) => {
			await tx
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.id, evaluatorSlot))
				.for("update");
			const pid = await pidOf(tx);
			mergeP = applyMergeGuests(mergeInput(keep, absorb));
			mergeP.catch(() => {});
			await waitForLockWait("role_slots", pid);
			// The FK check on evaluates_slot_id key-shares the speaker slot.
			await tx
				.update(roleSlots)
				.set({ evaluatesSlotId: speakerSlot })
				.where(eq(roleSlots.id, evaluatorSlot));
		});
		await expect(mergeP).resolves.toMatchObject({ refusal: null });

		const [ev] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, evaluatorSlot));
		expect(ev?.assignedGuestId).toBe(keep);
		expect(ev?.evaluatesSlotId).toBe(speakerSlot);
	});
});

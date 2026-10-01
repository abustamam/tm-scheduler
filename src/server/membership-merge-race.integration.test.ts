/**
 * A member merge racing the writers that reference the absorbed membership
 * (#1035), driven on real connections.
 *
 * `collapseMemberships` re-points every FK naming the absorbed membership and
 * then DELETEs it. A claim or identified ballot for the absorbed membership
 * that commits AFTER the re-point and BEFORE the DELETE is then hit by `on
 * delete set null`: a slot `claimed` by nobody, or an identified ballot with no
 * voter counted beside the keeper's own.
 *
 * The window is made deterministic by a third connection holding `FOR KEY
 * SHARE` on the absorbed membership: the merge's DELETE parks on it (observed
 * through `pg_blocking_pids`, so it is provably past every re-point), the
 * writer runs, and only then is the hold let go. Without the merge lock the
 * writer commits inside the window and the orphan appears; with it the writer
 * parks on the merge and is refused once the membership is gone.
 *
 * The writer-first cases are the other half: a writer already in flight when
 * the merge starts must make the merge WAIT, so its row is there to re-point,
 * and neither side may deadlock. A slot reassignment and a ballot cast are the
 * two writers #1031's `FOR UPDATE` attempt deadlocked against.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingVoteSessions,
	meetingVotes,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
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
const { claimSlotCore, reassignSlotCore } = await import("./slots-logic");
const { castVote, openVote } = await import("./voting-logic");
const { CLUB_BUSY_MESSAGE } = await import("./club-write-lock");

/** Run the merge on its own connection; resolves its backend pid first. */
function startMerge(clubId: string, keeperId: string, absorbedId: string) {
	let gotPid!: (pid: number) => void;
	const pid = new Promise<number>((r) => {
		gotPid = r;
	});
	const done = testDb.transaction(async (tx) => {
		const res = await tx.execute(sql`select pg_backend_pid() as pid`);
		gotPid(Number((res.rows[0] as { pid: number }).pid));
		await collapseMemberships(tx, clubId, keeperId, absorbedId);
	});
	done.catch(() => {});
	return { pid, done };
}

/**
 * Resolve once `subject` has settled OR a statement matching `match` is parked
 * behind `blockedBy`. Either is a stable state to release the hold from: the
 * unfixed writer finishes inside the window, the fixed one waits on the merge.
 */
async function settledOrBlocked(
	subject: Promise<unknown>,
	match: string,
	blockedBy: number,
): Promise<void> {
	let settled = false;
	subject.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (settled) return;
		const res = await testDb.execute(sql`
			select pid from pg_stat_activity
			where datname = current_database()
			  and state = 'active' and wait_event_type = 'Lock'
			  and query ilike ${`%${match}%`}
			  and ${blockedBy} = any(pg_blocking_pids(pid))
			limit 1`);
		if (res.rows.length > 0) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("the writer neither finished nor parked behind the merge");
}

/**
 * Every hold a test opens, so `afterEach` can let go of the ones a FAILING
 * test never reached — otherwise its cleanup parks behind them and a red run
 * reads as a hook timeout.
 */
const openHolds: Array<{ commit: () => Promise<void> }> = [];
async function openHold(work: Parameters<typeof openBlockingTx>[0]) {
	const h = await openBlockingTx(work);
	openHolds.push(h);
	return h;
}

/** Hold `FOR KEY SHARE` on a membership, so the merge's DELETE parks on it. */
const holdMembership = (memberId: string) =>
	openHold(async (tx) => {
		await tx.execute(
			sql`select 1 from members where id = ${memberId} for key share`,
		);
	});

const outcome = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: unknown) => (e instanceof Error ? e.message : String(e)),
	);

describe.skipIf(!hasTestDb)(
	"member merge vs concurrent writers (#1035)",
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
			absorbedId = row.id;
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		const readSlot = async () =>
			(
				await testDb
					.select({
						status: roleSlots.status,
						assignedMemberId: roleSlots.assignedMemberId,
						assignedGuestId: roleSlots.assignedGuestId,
					})
					.from(roleSlots)
					.where(eq(roleSlots.id, seed.slotId))
			)[0];

		const claimAsAbsorbed = () =>
			testDb.transaction((tx) =>
				claimSlotCore(tx, {
					slotId: seed.slotId,
					memberId: absorbedId,
					actorMemberId: absorbedId,
					proof: "session",
				}),
			);

		describe("slot claim", () => {
			it("a claim landing between the re-point and the DELETE never leaves a slot claimed by nobody", async () => {
				const hold = await holdMembership(absorbedId);
				const merge = startMerge(seed.clubId, keeperId, absorbedId);
				// Past every re-point: the DELETE is the merge's last statement.
				await waitForLockWait('delete from "members"', hold.pid);

				const claim = claimAsAbsorbed();
				const claimResult = outcome(claim);
				await settledOrBlocked(claim, "pg_advisory", await merge.pid);

				await hold.commit();
				await merge.done;

				const slot = await readSlot();
				// The orphan: claimed, no member, no guest. No later claim can take it.
				expect({
					orphaned:
						slot.status === "claimed" &&
						slot.assignedMemberId === null &&
						slot.assignedGuestId === null,
				}).toEqual({ orphaned: false });
				// The claim waited for the merge, found its membership gone, and was
				// refused before writing anything.
				expect(await claimResult).toBe(CLUB_BUSY_MESSAGE);
				expect(slot.status).toBe("open");
			});

			it("a claim already in flight makes the merge wait, and lands on the keeper", async () => {
				// Park the claim on its slot UPDATE, after it has taken the merge lock.
				const hold = await openHold(async (tx) => {
					await tx.execute(
						sql`select 1 from role_slots where id = ${seed.slotId} for update`,
					);
				});
				const claim = claimAsAbsorbed();
				claim.catch(() => {});
				const claimPid = await waitForLockWait('update "role_slots"', hold.pid);

				const merge = startMerge(seed.clubId, keeperId, absorbedId);
				await waitForLockWait("pg_advisory_xact_lock", claimPid);

				await hold.commit();
				await claim;
				await merge.done;

				const slot = await readSlot();
				expect(slot.status).toBe("claimed");
				expect(slot.assignedMemberId).toBe(keeperId);
			});

			it("a reassignment to the absorbed member in flight neither deadlocks the merge nor is lost to it", async () => {
				const reassign = await openHold(async (tx) => {
					await reassignSlotCore(tx, {
						slotId: seed.slotId,
						memberId: absorbedId,
						actorMemberId: seed.adminMemberId,
						proof: "session",
					});
				});
				const merge = startMerge(seed.clubId, keeperId, absorbedId);
				// The merge parks somewhere behind the reassignment's locks.
				await waitForLockWait("", reassign.pid);

				await reassign.commit();
				await merge.done;
				// Only "no deadlock, no throw" is this test's claim: reassignment is
				// not a writer the merge lock covers (see the PR), so where its
				// holder ends up is not asserted here.
			});
		});

		describe("identified ballot", () => {
			let sessionId: string;
			let speakerRoleId: string;
			const OTHER_PHONE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
			const ABSORBED_PHONE = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

			beforeEach(async () => {
				const [def] = await testDb
					.insert(roleDefinitions)
					.values({
						clubId: seed.clubId,
						name: "Speaker",
						category: "speaker",
						sortOrder: 99,
					})
					.returning({ id: roleDefinitions.id });
				speakerRoleId = def.id;
				await testDb.insert(roleSlots).values({
					meetingId: seed.meetingId,
					roleDefinitionId: speakerRoleId,
					slotIndex: 0,
					assignedMemberId: seed.adminMemberId,
				});
				await openVote({
					meetingId: seed.meetingId,
					category: "best_speaker",
					actorMemberId: seed.adminMemberId,
					clubId: seed.clubId,
				});
				const [s] = await testDb
					.select({ id: meetingVoteSessions.id })
					.from(meetingVoteSessions)
					.where(
						and(
							eq(meetingVoteSessions.meetingId, seed.meetingId),
							eq(meetingVoteSessions.category, "best_speaker"),
						),
					);
				sessionId = s.id;
			});

			const ballotAs = (voterId: string, deviceToken: string) => ({
				meetingId: seed.meetingId,
				category: "best_speaker" as const,
				voter: { kind: "member" as const, id: voterId },
				candidate: { kind: "member" as const, id: seed.adminMemberId },
				deviceToken,
			});

			const sessionBallots = () =>
				testDb
					.select({
						voterMemberId: meetingVotes.voterMemberId,
						anonymous: meetingVotes.anonymous,
					})
					.from(meetingVotes)
					.where(eq(meetingVotes.sessionId, sessionId));

			it("a ballot landing between the re-point and the DELETE never becomes a second counted vote", async () => {
				// The keeper has voted already: the merge asserts the two rows were
				// always one person, so one ballot must survive.
				await castVote(ballotAs(keeperId, OTHER_PHONE));

				const hold = await holdMembership(absorbedId);
				const merge = startMerge(seed.clubId, keeperId, absorbedId);
				await waitForLockWait('delete from "members"', hold.pid);

				const cast = castVote(ballotAs(absorbedId, ABSORBED_PHONE));
				const castResult = outcome(cast);
				await settledOrBlocked(cast, "pg_advisory", await merge.pid);

				await hold.commit();
				await merge.done;

				const ballots = await sessionBallots();
				// The orphan: identified (not anonymous) with its voter gone.
				expect(
					ballots.filter((b) => !b.anonymous && b.voterMemberId === null),
				).toEqual([]);
				expect(ballots).toEqual([
					{ voterMemberId: keeperId, anonymous: false },
				]);
				expect(await castResult).toBe(CLUB_BUSY_MESSAGE);
			});

			// The candidate side of the same window: a ballot FOR the absorbed
			// member would keep its voter and lose its choice, counting for nobody.
			it.each([
				["an identified", "member"],
				["an anonymous", "anonymous"],
			] as const)("%s ballot naming the absorbed member never loses its candidate", async (_label, kind) => {
				await testDb.insert(roleSlots).values({
					meetingId: seed.meetingId,
					roleDefinitionId: speakerRoleId,
					slotIndex: 1,
					assignedMemberId: absorbedId,
				});

				const hold = await holdMembership(absorbedId);
				const merge = startMerge(seed.clubId, keeperId, absorbedId);
				await waitForLockWait('delete from "members"', hold.pid);

				const cast = castVote({
					meetingId: seed.meetingId,
					category: "best_speaker",
					voter:
						kind === "member"
							? { kind: "member", id: seed.adminMemberId }
							: { kind: "anonymous" },
					candidate: { kind: "member", id: absorbedId },
					deviceToken: ABSORBED_PHONE,
				});
				const castResult = outcome(cast);
				await settledOrBlocked(cast, "pg_advisory", await merge.pid);

				await hold.commit();
				await merge.done;

				const ballots = await testDb
					.select({
						candidateMemberId: meetingVotes.candidateMemberId,
						candidateGuestId: meetingVotes.candidateGuestId,
						candidateWriteIn: meetingVotes.candidateWriteIn,
					})
					.from(meetingVotes)
					.where(eq(meetingVotes.sessionId, sessionId));
				expect(
					ballots.filter(
						(b) =>
							b.candidateMemberId === null &&
							b.candidateGuestId === null &&
							b.candidateWriteIn === null,
					),
				).toEqual([]);
				expect(ballots).toEqual([]);
				expect(await castResult).toBe(CLUB_BUSY_MESSAGE);
			});

			it("a ballot already in flight makes the merge wait, lands on the keeper, and neither deadlocks", async () => {
				// The absorbed membership opened the vote too, so the merge has the
				// session row to update — #1031's cast-vs-merge deadlock shape.
				await testDb
					.update(meetingVoteSessions)
					.set({ openedByMemberId: absorbedId })
					.where(eq(meetingVoteSessions.id, sessionId));

				// Park the cast on its session `FOR SHARE`, after it took the merge lock.
				const hold = await openHold(async (tx) => {
					await tx.execute(
						sql`select 1 from meeting_vote_sessions where id = ${sessionId} for update`,
					);
				});
				const cast = castVote(ballotAs(absorbedId, ABSORBED_PHONE));
				cast.catch(() => {});
				const castPid = await waitForLockWait(
					'insert into "meeting_votes"',
					hold.pid,
				);

				const merge = startMerge(seed.clubId, keeperId, absorbedId);
				await waitForLockWait("pg_advisory_xact_lock", castPid);

				await hold.commit();
				await cast;
				await merge.done;

				expect(await sessionBallots()).toEqual([
					{ voterMemberId: keeperId, anonymous: false },
				]);
			});
		});
	},
);

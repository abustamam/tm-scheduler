/**
 * #1623: a guest merge must not deadlock (40P01) with the KEPT guest's own first
 * ballot or check-in, in a meeting where the absorbed guest already has one.
 *
 * The shape: the writer's INSERT ... ON CONFLICT puts an uncommitted entry in
 * the (session, voter guest) / (meeting, guest) unique index, and only at the
 * end of the statement does its foreign-key check key-share the kept guest. A
 * merge that already holds the kept guest FOR UPDATE makes the writer wait on
 * it, and the merge's re-point of the absorbed guest's row onto the kept guest
 * collides with that pending index entry: each waits on the other.
 *
 * Ordering is by the lock graph, not luck. A blocker transaction holds a
 * `guest_invites` row of the absorbed guest, which the merge re-points AFTER it
 * has locked both guest rows, so the merge is parked holding them
 * (`waitForLockWait`). The REAL writer (`castVote`, `addGuestPresent`) is then
 * started and proven blocked behind the merge, and only then is the blocker
 * committed. With the guest key share taken before the writer's index entry the
 * writer waits first and nothing cycles; without it the merge and the writer
 * close the cycle on every run.
 *
 * Every test states its card: protects=…; fails_when=…; no_claim=….
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guestInvites,
	guests,
	meetingAttendance,
	meetingBallotGuests,
	meetingVoteSessions,
	meetingVotes,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMergeGuests } = await import("#/server/guest-merge-logic");
const { applyDeleteGuest } = await import("#/server/guest-pipeline-logic");
const { castVote, openVote } = await import("#/server/voting-logic");
const { addGuestPresent } = await import("#/server/minutes-logic");

const settle = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: unknown) => e as { code?: string; message?: string },
	);

const TOKEN = "0b7c9f6e-3a1d-4c2b-8e5f-6a7b8c9d0e1f";

describe.skipIf(!hasTestDb)(
	"guest merge vs the kept guest's first ballot / check-in (#1623)",
	() => {
		let seed: SeededClub;
		let keep: string;
		let absorb: string;
		beforeEach(async () => {
			seed = await seedClub();
			keep = await mkGuest("Keeper");
			absorb = await mkGuest("Absorbed");
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

		/**
		 * Run `merge` parked on a blocker's `guest_invites` row (so it holds both
		 * guest rows), start `writer` and prove it is blocked behind the merge, then
		 * release. Returns both settled outcomes.
		 */
		async function raceMergeAgainst(writer: () => Promise<unknown>) {
			const [invite] = await testDb
				.insert(guestInvites)
				.values({
					clubId: seed.clubId,
					guestId: absorb,
					meetingId: seed.meetingId,
				})
				.returning({ id: guestInvites.id });
			if (!invite) throw new Error("seed invite failed");
			const blocker = await openBlockingTx(async (tx) => {
				await tx
					.select({ id: guestInvites.id })
					.from(guestInvites)
					.where(eq(guestInvites.id, invite.id))
					.for("update");
			});
			const merge = settle(
				applyMergeGuests({
					clubId: seed.clubId,
					keepGuestId: keep,
					absorbGuestId: absorb,
					actorUserId: seed.adminUserId,
				}),
			);
			let writerOutcome!: Promise<unknown>;
			try {
				const mergePid = await waitForLockWait("guest_invites", blocker.pid);
				writerOutcome = settle(writer());
				await waitForLockWait("guest", mergePid);
			} finally {
				await blocker.commit();
			}
			return { mergeError: await merge, writerError: await writerOutcome };
		}

		// protects=a merge racing the kept guest's first identified ballot, in a
		//   session where the absorbed guest already voted
		// fails_when=castVote does not key-share the voter guest before its
		//   INSERT ... ON CONFLICT writes the index entry (40P01)
		// no_claim=says nothing about which ballot wins a committed collision (the
		//   merge's own suite)
		it("the kept guest's first ballot and the merge both complete, one ballot remains", async () => {
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					sortOrder: 99,
				})
				.returning({ id: roleDefinitions.id });
			await testDb.insert(roleSlots).values({
				meetingId: seed.meetingId,
				roleDefinitionId: def?.id ?? "",
				slotIndex: 0,
				assignedMemberId: seed.adminMemberId,
			});
			await openVote({
				meetingId: seed.meetingId,
				category: "best_speaker",
				actorMemberId: seed.adminMemberId,
				clubId: seed.clubId,
			});
			const session = await testDb.query.meetingVoteSessions.findFirst({
				where: (s, { eq: e }) => e(s.meetingId, seed.meetingId),
			});
			if (!session) throw new Error("no session");
			await testDb.insert(meetingBallotGuests).values([
				{ meetingId: seed.meetingId, guestId: keep },
				{ meetingId: seed.meetingId, guestId: absorb },
			]);
			await testDb.insert(meetingVotes).values({
				sessionId: session.id,
				voterGuestId: absorb,
				candidateMemberId: seed.adminMemberId,
				deviceToken: TOKEN,
			});

			const { mergeError, writerError } = await raceMergeAgainst(() =>
				castVote({
					meetingId: seed.meetingId,
					category: "best_speaker",
					voter: { kind: "guest", id: keep },
					candidate: { kind: "member", id: seed.adminMemberId },
					deviceToken: TOKEN,
				}),
			);
			expect(mergeError).toBeNull();
			expect(writerError).toBeNull();

			const rows = await testDb
				.select({ voter: meetingVotes.voterGuestId })
				.from(meetingVotes)
				.where(eq(meetingVotes.sessionId, session.id));
			expect(rows).toEqual([{ voter: keep }]);
		});

		// protects=a merge racing the kept guest's check-in at a meeting where the
		//   absorbed guest is already present
		// fails_when=addGuestPresent does not key-share the guest before its
		//   INSERT ... ON CONFLICT writes the index entry (40P01)
		// no_claim=says nothing about attendance modes (the merge's own suite)
		it("the kept guest's check-in and the merge both complete, one attendance row remains", async () => {
			await testDb.insert(meetingAttendance).values({
				meetingId: seed.meetingId,
				guestId: absorb,
				status: "present",
			});

			const { mergeError, writerError } = await raceMergeAgainst(() =>
				addGuestPresent({ meetingId: seed.meetingId, guestId: keep }),
			);
			expect(mergeError).toBeNull();
			expect(writerError).toBeNull();

			const rows = await testDb
				.select({ guestId: meetingAttendance.guestId })
				.from(meetingAttendance)
				.where(
					and(
						eq(meetingAttendance.meetingId, seed.meetingId),
						eq(meetingAttendance.status, "present"),
						isNotNull(meetingAttendance.guestId),
					),
				);
			expect(rows).toEqual([{ guestId: keep }]);
		});

		// ---- ordered by the WRITER being parked (#1623 fix round) -------------
		// The writer holds whatever locks castVote takes before its INSERT, parked
		// on the vote session row a blocker holds; the other transaction (merge or
		// delete) is then started and proven blocked behind the writer. Releasing
		// the blocker lets the writer continue. If the writer holds a guest key
		// share while the other side holds the row it needs next, the release is a
		// 40P01 on every run; in the correct order the other side waits on the
		// writer and both complete.

		async function setupSession() {
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					sortOrder: 99,
				})
				.returning({ id: roleDefinitions.id });
			await testDb.insert(roleSlots).values({
				meetingId: seed.meetingId,
				roleDefinitionId: def?.id ?? "",
				slotIndex: 0,
				assignedMemberId: seed.adminMemberId,
			});
			await openVote({
				meetingId: seed.meetingId,
				category: "best_speaker",
				actorMemberId: seed.adminMemberId,
				clubId: seed.clubId,
			});
			const session = await testDb.query.meetingVoteSessions.findFirst({
				where: (s, { eq: e }) => e(s.meetingId, seed.meetingId),
			});
			if (!session) throw new Error("no session");
			await testDb.insert(meetingBallotGuests).values([
				{ meetingId: seed.meetingId, guestId: keep },
				{ meetingId: seed.meetingId, guestId: absorb },
			]);
			return session.id;
		}

		/** Poll until a backend OTHER than `writerPid` is lock-waiting behind it. */
		async function waitForOtherWaiter(writerPid: number) {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const res = await testDb.execute(sql`
					select pid from pg_stat_activity
					where datname = current_database()
					  and state = 'active' and wait_event_type = 'Lock'
					  and pid <> ${writerPid}
					  and ${writerPid} = any(pg_blocking_pids(pid))
					limit 1`);
				if (res.rows.length > 0) return;
				await new Promise((r) => setTimeout(r, 25));
			}
			throw new Error("nothing parked behind the writer");
		}

		const mergeKeepAbsorb = () =>
			applyMergeGuests({
				clubId: seed.clubId,
				keepGuestId: keep,
				absorbGuestId: absorb,
				actorUserId: seed.adminUserId,
			});

		async function raceParkedWriter(
			sessionId: string,
			writer: () => Promise<unknown>,
			other: () => Promise<unknown>,
		) {
			const blocker = await openBlockingTx(async (tx) => {
				await tx
					.select({ id: meetingVoteSessions.id })
					.from(meetingVoteSessions)
					.where(eq(meetingVoteSessions.id, sessionId))
					.for("update");
			});
			let writerOutcome!: Promise<unknown>;
			let otherOutcome!: Promise<unknown>;
			try {
				writerOutcome = settle(writer());
				const writerPid = await waitForLockWait(
					"meeting_vote_sessions",
					blocker.pid,
				);
				otherOutcome = settle(other());
				// Any statement of the other side blocked by the writer: the merge
				// or delete is parked behind it, not racing past it.
				await waitForLockWait("", writerPid);
			} finally {
				await blocker.commit();
			}
			return {
				writerError: await writerOutcome,
				otherError: await otherOutcome,
			};
		}

		const revote = (voter: string) => () =>
			castVote({
				meetingId: seed.meetingId,
				category: "best_speaker",
				voter: { kind: "guest", id: voter },
				candidate: { kind: "member", id: seed.adminMemberId },
				deviceToken: TOKEN,
			});

		// protects=the ABSORBED guest re-voting while the merge locks its ballot
		// fails_when=castVote key-shares a guest before it locks the voter's
		//   existing ballot (the merge locks the ballot first: 40P01)
		// no_claim=says nothing about which device may change a ballot
		it("the absorbed guest re-voting and the merge both complete", async () => {
			const sessionId = await setupSession();
			await testDb.insert(meetingVotes).values({
				sessionId,
				voterGuestId: absorb,
				candidateMemberId: seed.adminMemberId,
				deviceToken: TOKEN,
			});
			const out = await raceParkedWriter(
				sessionId,
				revote(absorb),
				mergeKeepAbsorb,
			);
			expect(out).toEqual({ writerError: null, otherError: null });
			const rows = await testDb
				.select({ voter: meetingVotes.voterGuestId })
				.from(meetingVotes)
				.where(eq(meetingVotes.sessionId, sessionId));
			expect(rows).toEqual([{ voter: keep }]);
		});

		// protects=the KEPT guest re-voting while its existing ballot names the
		//   absorbed guest as candidate (the merge pre-locks that ballot)
		// fails_when=castVote key-shares a guest before it locks the voter's
		//   existing ballot (40P01)
		// no_claim=says nothing about the surviving ballot's candidate
		it("the kept guest re-voting a ballot naming the absorbed guest and the merge both complete", async () => {
			const sessionId = await setupSession();
			await testDb.insert(meetingVotes).values({
				sessionId,
				voterGuestId: keep,
				candidateGuestId: absorb,
				deviceToken: TOKEN,
			});
			const out = await raceParkedWriter(
				sessionId,
				revote(keep),
				mergeKeepAbsorb,
			);
			expect(out).toEqual({ writerError: null, otherError: null });
		});

		// protects=a guest re-voting while the guest delete locks its ballot
		// fails_when=castVote key-shares the guest before it locks the guest's own
		//   existing ballot (applyDeleteGuest locks the vote first: 40P01)
		// no_claim=says nothing about what a delete refuses
		it("a guest re-voting and applyDeleteGuest on it both complete", async () => {
			const sessionId = await setupSession();
			await testDb.insert(meetingVotes).values({
				sessionId,
				voterGuestId: absorb,
				candidateMemberId: seed.adminMemberId,
				deviceToken: TOKEN,
			});
			const out = await raceParkedWriter(sessionId, revote(absorb), () =>
				applyDeleteGuest({
					clubId: seed.clubId,
					guestId: absorb,
					actorMemberId: seed.adminMemberId,
				}),
			);
			expect(out).toEqual({ writerError: null, otherError: null });
			const gone = await testDb
				.select({ id: guests.id })
				.from(guests)
				.where(eq(guests.id, absorb));
			expect(gone).toEqual([]);
		});

		// protects=the voter and the candidate are both merge parties (the kept
		//   guest votes for the absorbed guest) in either id order
		// fails_when=castVote key-shares the voter alone, so the candidate is
		//   key-shared by the INSERT's FK check after the voter (40P01 when the
		//   absorbed guest's id is the lower)
		// no_claim=says nothing about whether the merged ballot is a self-vote
		it.each([
			["kept id below absorbed id", true],
			["absorbed id below kept id", false],
		])("the kept guest's first ballot for the absorbed guest and the merge both complete (%s)", async (_label, keepLow) => {
			if (keep < absorb !== keepLow) [keep, absorb] = [absorb, keep];
			const sessionId = await setupSession();
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: null, assignedGuestId: absorb })
				.where(eq(roleSlots.meetingId, seed.meetingId));
			const out = await raceParkedWriter(
				sessionId,
				() =>
					castVote({
						meetingId: seed.meetingId,
						category: "best_speaker",
						voter: { kind: "guest", id: keep },
						candidate: { kind: "guest", id: absorb },
						deviceToken: TOKEN,
					}),
				mergeKeepAbsorb,
			);
			expect(out).toEqual({ writerError: null, otherError: null });
		});

		// protects=the voter and candidate guests are key-shared in ONE statement
		//   in id order, the order the merge takes its two guest rows
		// fails_when=a writer locks the HIGHER guest id first: with a blocker
		//   holding the higher guest, it holds it while the merge takes the lower
		//   and waits for the higher (40P01 on release). It does NOT catch a bare
		//   ORDER BY removal (an index scan may still return ascending ids) and
		//   does not test the one-statement rule
		// no_claim=says nothing about lock strength
		it("the voter and candidate guests are key-shared in id order", async () => {
			if (keep > absorb) [keep, absorb] = [absorb, keep];
			// The ORDER BY under test must disagree with every other plausible
			// order: absorb (the higher id) must come first by name.
			await testDb
				.update(guests)
				.set({ name: "A" })
				.where(eq(guests.id, absorb));
			await testDb.update(guests).set({ name: "B" }).where(eq(guests.id, keep));
			const sessionId = await setupSession();
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: null, assignedGuestId: absorb })
				.where(eq(roleSlots.meetingId, seed.meetingId));
			const blocker = await openBlockingTx(async (tx) => {
				await tx
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.id, absorb))
					.for("update");
			});
			let writerOutcome!: Promise<unknown>;
			let mergeOutcome!: Promise<unknown>;
			try {
				writerOutcome = settle(
					castVote({
						meetingId: seed.meetingId,
						category: "best_speaker",
						voter: { kind: "guest", id: keep },
						candidate: { kind: "guest", id: absorb },
						deviceToken: TOKEN,
					}),
				);
				const writerPid = await waitForLockWait("guests", blocker.pid);
				mergeOutcome = settle(mergeKeepAbsorb());
				// Parked either behind the blocker (it took the lower guest and
				// waits for the higher) or behind the writer (the lower guest).
				await waitForOtherWaiter(writerPid);
			} finally {
				await blocker.commit();
			}
			expect(await writerOutcome).toBeNull();
			expect(await mergeOutcome).toBeNull();
			expect(sessionId).toBeTruthy();
		});
	},
);

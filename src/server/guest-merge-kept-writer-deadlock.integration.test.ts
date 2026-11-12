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
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guestInvites,
	guests,
	meetingAttendance,
	meetingBallotGuests,
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
const { castVote, openVote } = await import("#/server/voting-logic");
const { addGuestPresent } = await import("#/server/minutes-logic");

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
			const settle = (p: Promise<unknown>) =>
				p.then(
					() => null,
					(e: unknown) => e as { code?: string; message?: string },
				);
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
					),
				);
			expect(rows.filter((r) => r.guestId)).toEqual([{ guestId: keep }]);
		});
	},
);

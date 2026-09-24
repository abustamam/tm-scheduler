/**
 * DB-backed tests for the PUBLIC WRITE surface's archive gate (#555, the other
 * half of #544).
 *
 * #544 closed the reads and deliberately scoped writes out, which created an
 * asymmetry rather than a partial fix: some of these paths MINT rows carrying
 * names — `captureGuestVisit` (a guest row with optional email and phone),
 * `joinBallotAsGuest` (a ballot-guest identity) — so a taken-down club kept
 * accreting PII while every read of it returned empty. Nobody could notice: the
 * writer got a silent success with no read-back, and no admin could reach the
 * club either, because `requireMembership` throws for an archived one. ADR-0016
 * says archiving "locks out every member and admin"; until this it locked out
 * neither.
 *
 * `applySelfAdd` was the third of those row-minting paths and the reason the
 * asymmetry mattered most — it minted a `people` row PLUS a `members` row. It is
 * gone: #616 admin-gated its only caller, so it stopped being session-less, and
 * #630 deleted it. Its case left this file with it. What it taught did not — see
 * CODING_STANDARDS.md's "WRITES are closed too", which still states the rule its
 * in-lock placement is the worked example of.
 *
 * ## Why these paths and not every write
 *
 * `assertClubNotArchived` is reachable for free from `requireMembership`, so
 * every AUTHED mutation already had the gate. The session-less ones never touch
 * that choke point — the anonymous roster-pick identity is the dominant path in
 * this product. The list is not curated: it is exactly the set
 * `public-readers-archive-gate.guard.test.ts` waived with the reason
 * `"write — #544 follow-up"`, and that guard now requires each one to name its
 * gate instead, in its `WRITE_GATES` table. That table is the inventory —
 * count there; the split of its rows between this suite and the feature
 * suites that execute the rest is written out above it. The ones executed
 * elsewhere each need a fixture none of the cases below build: `confirmSlotCore`
 * (#661, which gave an authed-only write a session-less holder arm) in
 * `slots-confirm.integration.test.ts`, which needs a CLAIMED slot and a holder;
 * and `recordTiming` (#730, the Timer's measured times) in
 * `timings.integration.test.ts`, which needs a meeting whose Timer slot is
 * assigned plus a timeable slot to record against.
 *
 * ## Each case is a BEFORE/AFTER pair, for the reason #544's suite gives
 *
 * A write that throws for an archived club proves nothing on its own — plenty of
 * unrelated setup problems also throw, so the assertion would pass with the gate
 * deleted if the fixture were wrong in any other way. So every case first proves
 * the write SUCCEEDS against the live club, then archives and proves it is
 * refused. The "before" half is what fails if someone deletes a gate, because
 * the "after" then matches it.
 *
 * A THROW, not a not-found shape — the opposite of the read gate, on purpose.
 * Reads collapse archived into not-found so an archived club is
 * indistinguishable from one that never existed; a write already has an error
 * path to every caller (the name-pick dialog surfaces the message verbatim), and
 * silently accepting a write that will never be readable is worse than telling
 * the person their club is gone.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/public-writers-archive-gate.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	guests,
	meetingCandidateDisqualifications,
	meetings,
	roleSlots,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { captureGuestVisit } = await import("#/server/guest-pipeline-logic");
const { claimSlotCore, reassignSlotCore, releaseSlotCore } = await import(
	"#/server/slots-logic"
);
const {
	castVote,
	joinBallotAsGuest,
	openVote,
	closeVote,
	disqualifyCandidate,
	undoDisqualification,
} = await import("#/server/voting-logic");

let seeded: SeededClub | null = null;

afterEach(async () => {
	if (seeded) {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	}
});

async function seedLiveClub(): Promise<SeededClub> {
	const s = await seedClub();
	seeded = s;
	return s;
}

const archive = (clubId: string) =>
	testDb
		.update(clubs)
		.set({ archivedAt: new Date() })
		.where(eq(clubs.id, clubId));

/** The canonical rejection, so a case cannot pass on an unrelated throw. */
const ARCHIVED = new RegExp(CLUB_ARCHIVED_MESSAGE.replace(/\./g, "\\."));

describe.skipIf(!hasTestDb)(
	"public writes refuse an archived club (#555)",
	() => {
		/**
		 * The row-minting pair first — the reason this issue mattered more after
		 * #544 rather than less.
		 *
		 * A THROW is not the whole promise on a minting path: a throw after a
		 * partial insert looks identical from the caller's side. So this asserts
		 * the observable the gate actually controls — that the refusal left NO
		 * `guests` row behind — alongside the before/after pair.
		 */
		it("captureGuestVisit — no guest name, email or phone collected", async () => {
			const s = await seedLiveClub();
			const live = await captureGuestVisit({
				clubId: s.clubId,
				name: "Live Guest",
				email: "live@example.com",
				phone: "555-0100",
			});
			expect(live).toBeTruthy();

			const countGuests = async () =>
				(
					await testDb
						.select({ id: guests.id })
						.from(guests)
						.where(eq(guests.clubId, s.clubId))
				).length;
			const priorCount = await countGuests();

			await archive(s.clubId);
			await expect(
				captureGuestVisit({
					clubId: s.clubId,
					name: "Archived Guest",
					email: "archived@example.com",
					phone: "555-0199",
				}),
			).rejects.toThrow(ARCHIVED);
			expect(await countGuests()).toBe(priorCount);
		});

		it("joinBallotAsGuest — no ballot-guest identity minted", async () => {
			const s = await seedLiveClub();
			const live = await joinBallotAsGuest({
				meetingId: s.meetingId,
				name: "Live Voter",
			});
			expect(live.name).toBe("Live Voter");

			await archive(s.clubId);
			await expect(
				joinBallotAsGuest({ meetingId: s.meetingId, name: "Archived Voter" }),
			).rejects.toThrow(ARCHIVED);
		});

		/** The remaining five write nothing new but still mutate a taken-down club. */
		it("castVote — refused", async () => {
			const s = await seedLiveClub();
			await archive(s.clubId);
			await expect(
				castVote({
					meetingId: s.meetingId,
					category: "best_speaker",
					voter: { kind: "member", id: s.memberId },
					candidate: { kind: "writeIn", name: "Someone" },
				}),
			).rejects.toThrow(ARCHIVED);
		});

		/**
		 * These two gate in the SEAM rather than in `openVoteFn`/`closeVoteFn`'s
		 * handlers, which is why they are testable at all. `WindowInput` already
		 * carries `clubId`, so the gate cost nothing to move — and a handler body is
		 * unreachable from vitest, so gating there would have left both covered by a
		 * source grep and nothing else.
		 */
		it("openVote — refused, and the window is not opened", async () => {
			const s = await seedLiveClub();
			await openVote({
				meetingId: s.meetingId,
				clubId: s.clubId,
				category: "best_speaker",
				actorMemberId: s.adminMemberId,
			});
			await closeVote({
				meetingId: s.meetingId,
				clubId: s.clubId,
				category: "best_speaker",
				actorMemberId: s.adminMemberId,
			});

			await archive(s.clubId);
			await expect(
				openVote({
					meetingId: s.meetingId,
					clubId: s.clubId,
					category: "best_speaker",
					actorMemberId: s.adminMemberId,
				}),
			).rejects.toThrow(ARCHIVED);
		});

		it("closeVote — refused", async () => {
			const s = await seedLiveClub();
			await openVote({
				meetingId: s.meetingId,
				clubId: s.clubId,
				category: "best_evaluator",
				actorMemberId: s.adminMemberId,
			});

			await archive(s.clubId);
			await expect(
				closeVote({
					meetingId: s.meetingId,
					clubId: s.clubId,
					category: "best_evaluator",
					actorMemberId: s.adminMemberId,
				}),
			).rejects.toThrow(ARCHIVED);
		});

		// #723. Both gate in their seam, so both are executable here. The undo is
		// the one worth having beside the set: it is a DELETE, and "an archived
		// club cannot be written to" is easy to read as being about rows appearing
		// — a delete that still ran would leave a taken-down club's live vote state
		// changing under an operator who can no longer see it.
		it("disqualifyCandidate — refused, and no ruling is recorded", async () => {
			const s = await seedLiveClub();
			// The BEFORE half, per this file's discipline: the same call against the
			// LIVE club succeeds, so the refusal below cannot be some unrelated
			// fixture problem throwing. A different category, because the unique
			// index would refuse a second ruling on the same candidate and that
			// would pass the `rejects` assertion for the wrong reason.
			await disqualifyCandidate({
				meetingId: s.meetingId,
				clubId: s.clubId,
				category: "best_evaluator",
				candidate: { kind: "member", id: s.adminMemberId },
				reason: "Outside the qualifying window",
				actorMemberId: s.adminMemberId,
			});

			await archive(s.clubId);
			await expect(
				disqualifyCandidate({
					meetingId: s.meetingId,
					clubId: s.clubId,
					category: "best_speaker",
					candidate: { kind: "member", id: s.adminMemberId },
					reason: "Outside the qualifying window",
					actorMemberId: s.adminMemberId,
				}),
			).rejects.toThrow(ARCHIVED);
			// Only the one written before the archive — the refused call left
			// nothing behind.
			expect(
				await testDb
					.select({ category: meetingCandidateDisqualifications.category })
					.from(meetingCandidateDisqualifications)
					.where(eq(meetingCandidateDisqualifications.meetingId, s.meetingId)),
			).toEqual([{ category: "best_evaluator" }]);
		});

		it("undoDisqualification — refused, and the ruling stands", async () => {
			const s = await seedLiveClub();
			await disqualifyCandidate({
				meetingId: s.meetingId,
				clubId: s.clubId,
				category: "best_speaker",
				candidate: { kind: "member", id: s.adminMemberId },
				reason: "Outside the qualifying window",
				actorMemberId: s.adminMemberId,
			});

			await archive(s.clubId);
			await expect(
				undoDisqualification({
					meetingId: s.meetingId,
					clubId: s.clubId,
					category: "best_speaker",
					candidate: { kind: "member", id: s.adminMemberId },
					actorMemberId: s.adminMemberId,
				}),
			).rejects.toThrow(ARCHIVED);
			expect(
				await testDb
					.select({ id: meetingCandidateDisqualifications.id })
					.from(meetingCandidateDisqualifications)
					.where(eq(meetingCandidateDisqualifications.meetingId, s.meetingId)),
			).toHaveLength(1);
		});

		/**
		 * #809 moved `releaseSlot`'s gate into `releaseSlotCore`, so it joins the
		 * seam-gated cases above — and it had to, rather than merely being allowed
		 * to. MEASURED: with the call deleted from the core, the re-pointed
		 * `WRITE_GATES` row still passes, because that row is a file-level
		 * `toContain` and `slots-logic.ts` names `assertClubNotArchived` in three
		 * separate functions. The guard says the module has a gate; only this says
		 * a release reaches one.
		 *
		 * `assign_roles` reaches the same core from a bearer token, which is what
		 * makes the move worth more than tidiness: without it the MCP path would
		 * have had no archive gate of its own on the clear arm.
		 */
		it("releaseSlotCore — refused, and the slot keeps its holder", async () => {
			const s = await seedLiveClub();
			const hold = () =>
				testDb
					.update(roleSlots)
					.set({ assignedMemberId: s.memberId, status: "claimed" })
					.where(eq(roleSlots.id, s.slotId));
			const holderOf = async () =>
				(
					await testDb
						.select({ assignedMemberId: roleSlots.assignedMemberId })
						.from(roleSlots)
						.where(eq(roleSlots.id, s.slotId))
				)[0]?.assignedMemberId ?? null;

			// BEFORE: the same clear against the LIVE club succeeds.
			await hold();
			await testDb.transaction((tx) =>
				releaseSlotCore(tx, {
					slotId: s.slotId,
					actorMemberId: s.adminMemberId,
				}),
			);
			expect(await holderOf()).toBeNull();

			// AFTER: archived, and the holder stays put.
			await hold();
			await archive(s.clubId);
			await expect(
				testDb.transaction((tx) =>
					releaseSlotCore(tx, {
						slotId: s.slotId,
						actorMemberId: s.adminMemberId,
					}),
				),
			).rejects.toThrow(ARCHIVED);
			expect(await holderOf()).toBe(s.memberId);
		});

		/**
		 * The ORDER, which a presence check cannot see — the same property
		 * `timings.integration.test.ts` asserts for `recordTiming`.
		 *
		 * With the lock check first, an archived club's COMPLETED meeting answers
		 * "This meeting is locked", which both discloses meeting state the
		 * takedown was meant to end and answers differently from the same club's
		 * scheduled meeting. Takedown outranks every other reason to refuse.
		 */
		it("releaseSlotCore — an archived club's COMPLETED meeting still says archived", async () => {
			const s = await seedLiveClub();
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, s.meetingId));
			await archive(s.clubId);

			// Asserted on the MESSAGE rather than with `rejects.not.toThrow`, which
			// passes for a call that threw the wrong thing as readily as for one
			// that threw the right thing.
			const message = await testDb
				.transaction((tx) =>
					releaseSlotCore(tx, {
						slotId: s.slotId,
						actorMemberId: s.adminMemberId,
					}),
				)
				.then(
					() => "it did not throw at all",
					(err: unknown) => (err as Error).message,
				);
			expect(message).toBe(CLUB_ARCHIVED_MESSAGE);
			expect(message).not.toBe(MEETING_LOCKED_MESSAGE);
		});

		/**
		 * The LOCK check, which the two cases above cannot reach.
		 *
		 * Both of them archive the club first, so `assertClubNotArchived` throws
		 * before `assertMeetingNotLocked` is evaluated — the ordering case
		 * proves exactly that. So on a LIVE club the lock line had no cover at
		 * all: in the core, in the handler it moved out of, or in any source
		 * guard. It is also the second endpoint for the claim `assign_roles`
		 * makes about its own refusal, that the two sentences differ.
		 *
		 * Not strictly an archive case, but it belongs beside its sibling: the
		 * pair is what shows the two gates are independent and ordered.
		 */
		it("releaseSlotCore — a LIVE club's completed meeting refuses with the lock message", async () => {
			const s = await seedLiveClub();
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: s.memberId, status: "claimed" })
				.where(eq(roleSlots.id, s.slotId));
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, s.meetingId));

			const message = await testDb
				.transaction((tx) =>
					releaseSlotCore(tx, {
						slotId: s.slotId,
						actorMemberId: s.adminMemberId,
					}),
				)
				.then(
					() => "it did not throw at all",
					(err: unknown) => (err as Error).message,
				);
			expect(message).toBe(MEETING_LOCKED_MESSAGE);
			// The club is live, so this is the lock talking and not the archive.
			expect(message).not.toBe(CLUB_ARCHIVED_MESSAGE);
			const [row] = await testDb
				.select({ assignedMemberId: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, s.slotId));
			expect(row?.assignedMemberId).toBe(s.memberId);
		});

		/**
		 * #825. `claimSlot` and `reassignSlot` had NO archive gate anywhere in
		 * their chain, and `public-readers-archive-gate.guard.test.ts` could not
		 * see it: `requireMemberInClub` sat in its `SESSION_GUARDS` regex and
		 * dropped both from the sweep by name. Both now gate in their cores, so
		 * the refusal is executed here rather than grepped for — the guard's rows
		 * for them are file-level `toContain`s on a module that names the gate in
		 * several functions, and would stay green with either call deleted.
		 */
		const holderOf = async (slotId: string) =>
			(
				await testDb
					.select({
						assignedMemberId: roleSlots.assignedMemberId,
						status: roleSlots.status,
					})
					.from(roleSlots)
					.where(eq(roleSlots.id, slotId))
			)[0] ?? null;
		const reopen = (slotId: string) =>
			testDb
				.update(roleSlots)
				.set({ assignedMemberId: null, status: "open", claimedAt: null })
				.where(eq(roleSlots.id, slotId));
		const messageOf = (p: Promise<unknown>) =>
			p.then(
				() => "it did not throw at all",
				(err: unknown) => (err as Error).message,
			);

		it("claimSlotCore — refused, and the slot stays open", async () => {
			const s = await seedLiveClub();
			const claim = () =>
				testDb.transaction((tx) =>
					claimSlotCore(tx, {
						slotId: s.slotId,
						memberId: s.memberId,
						actorMemberId: s.memberId,
					}),
				);

			// BEFORE: the same claim against the LIVE club succeeds.
			await claim();
			expect(await holderOf(s.slotId)).toEqual({
				assignedMemberId: s.memberId,
				status: "claimed",
			});

			// AFTER: archived, and nothing is written.
			await reopen(s.slotId);
			await archive(s.clubId);
			await expect(claim()).rejects.toThrow(ARCHIVED);
			expect(await holderOf(s.slotId)).toEqual({
				assignedMemberId: null,
				status: "open",
			});
		});

		it("claimSlotCore — an archived club's COMPLETED meeting still says archived", async () => {
			const s = await seedLiveClub();
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, s.meetingId));
			await archive(s.clubId);

			const message = await messageOf(
				testDb.transaction((tx) =>
					claimSlotCore(tx, {
						slotId: s.slotId,
						memberId: s.memberId,
						actorMemberId: s.memberId,
					}),
				),
			);
			expect(message).toBe(CLUB_ARCHIVED_MESSAGE);
		});

		it("reassignSlotCore — refused, and the slot keeps its holder", async () => {
			const s = await seedLiveClub();
			const reassignTo = (memberId: string) =>
				testDb.transaction((tx) =>
					reassignSlotCore(tx, {
						slotId: s.slotId,
						memberId,
						actorMemberId: s.adminMemberId,
					}),
				);

			// BEFORE: reassigning on the LIVE club succeeds.
			await reassignTo(s.memberId);
			expect((await holderOf(s.slotId))?.assignedMemberId).toBe(s.memberId);

			// AFTER: archived, and the holder stays put.
			await archive(s.clubId);
			await expect(reassignTo(s.adminMemberId)).rejects.toThrow(ARCHIVED);
			expect((await holderOf(s.slotId))?.assignedMemberId).toBe(s.memberId);
		});

		it("reassignSlotCore — an archived club's COMPLETED meeting still says archived", async () => {
			const s = await seedLiveClub();
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, s.meetingId));
			await archive(s.clubId);

			const message = await messageOf(
				testDb.transaction((tx) =>
					reassignSlotCore(tx, {
						slotId: s.slotId,
						memberId: s.memberId,
						actorMemberId: s.adminMemberId,
					}),
				),
			);
			expect(message).toBe(CLUB_ARCHIVED_MESSAGE);
		});

		/**
		 * `updateSpeakerDetails` is the one that could NOT be moved into a seam:
		 * its logic is inline in the `createServerFn` handler, and lifting it out
		 * is a refactor this change is not. So it gates in the handler and is
		 * covered by the source guard (`public-readers-archive-gate.guard.test.ts`)
		 * instead, which is stated here rather than left for a reader to notice
		 * the absence.
		 *
		 * What IS assertable is the input to its gate: it passes `slot.clubId`
		 * from its own `roleSlots → meetings` join, so this pins that the join
		 * resolves the club the gate needs. A source guard can see the call; only
		 * this can see that the argument is right.
		 */
		it("a slot's resolved clubId is the meeting's club — the value the handler gates on", async () => {
			const s = await seedLiveClub();
			const [row] = await testDb
				.select({ clubId: meetings.clubId })
				.from(roleSlots)
				.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
				.where(eq(roleSlots.id, s.slotId))
				.limit(1);
			expect(row?.clubId).toBe(s.clubId);
		});
	},
);

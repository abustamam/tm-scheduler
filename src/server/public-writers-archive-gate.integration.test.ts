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
 * gate instead, in its `WRITE_GATES` table. Seven rows there; the five that gate
 * in a `-logic` SEAM are the five this file can execute, because a handler body
 * is unreachable from vitest.
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
import { clubs, guests, meetings, roleSlots } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { captureGuestVisit } = await import("#/server/guest-pipeline-logic");
const { castVote, joinBallotAsGuest, openVote, closeVote } = await import(
	"#/server/voting-logic"
);

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

		/**
		 * `releaseSlot` and `updateSpeakerDetails` are the two that could NOT be moved
		 * into a seam: their logic is inline in the `createServerFn` handler, and
		 * lifting it out is a refactor this change is not. So they gate in the handler
		 * and are covered by the source guard
		 * (`public-readers-archive-gate.guard.test.ts`) instead, which is stated here
		 * rather than left for a reader to notice the absence.
		 *
		 * What IS assertable is the input to their gate: both pass
		 * `slot.clubId` from their own `roleSlots → meetings` join, so this pins that
		 * the join resolves the club the gate needs. A source guard can see the call;
		 * only this can see that the argument is right.
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

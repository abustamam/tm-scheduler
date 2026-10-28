/**
 * DB-backed tests for #1323: undoing a guest conversion deletes the membership,
 * and `meeting_votes.candidate_member_id` / `voter_member_id` are ON DELETE SET
 * NULL, so a ballot still being counted would lose the member's votes (the
 * tally drops a candidate-less row). Decided 2026-10-26 (option A): the undo
 * refuses while the member is a candidate or voter in a ballot whose award is
 * not yet recorded, and says why.
 *
 * Beside `guest-pipeline.integration.test.ts` to keep the issue to one cited
 * source file. `#/db` is mocked to the TEST_DATABASE_URL client; the suite
 * skips when unset.
 */
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAwards,
	meetings,
	meetingVoteSessions,
	meetingVotes,
	members,
	people,
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

const {
	applyConvertGuestToMember,
	applyUndoGuestConversion,
	UNDO_OPEN_BALLOT_MESSAGE,
} = await import("#/server/guest-pipeline-logic");

describe.skipIf(!hasTestDb)(
	"undo guest conversion: ballot votes (#1323)",
	() => {
		let seed: SeededClub;
		let strayPeople: string[] = [];

		beforeEach(async () => {
			seed = await seedClub();
			strayPeople = [];
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			if (strayPeople.length > 0) {
				await testDb.delete(people).where(inArray(people.id, strayPeople));
			}
		});

		async function converted(name: string) {
			const [g] = await testDb
				.insert(guests)
				.values(await withGuestPerson({ clubId: seed.clubId, name }, testDb))
				.returning({ id: guests.id });
			if (!g) throw new Error("Failed to seed guest");
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId: g.id,
				actorMemberId: seed.adminMemberId,
			});
			strayPeople.push(res.personId);
			return { guestId: g.id, ...res };
		}

		function undo(guestId: string) {
			return applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
		}

		async function session(category: "best_speaker" | "best_table_topics") {
			const [s] = await testDb
				.insert(meetingVoteSessions)
				.values({ meetingId: seed.meetingId, category })
				.returning({ id: meetingVoteSessions.id });
			if (!s) throw new Error("Failed to seed session");
			return s.id;
		}

		async function award(
			category: "best_speaker" | "best_table_topics",
			meetingId: string = seed.meetingId,
		) {
			await testDb.insert(meetingAwards).values({
				meetingId,
				category,
				memberId: seed.memberId,
			});
		}

		async function expectMembershipSurvives(membershipId: string) {
			const [m] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, membershipId));
			expect(m?.id).toBe(membershipId);
		}

		it("refuses while the member is a candidate on an open ballot, and keeps the vote", async () => {
			const { guestId, membershipId } = await converted("Candidate Cara");
			const sessionId = await session("best_speaker");
			await testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: seed.memberId,
				candidateMemberId: membershipId,
			});
			await expect(undo(guestId)).rejects.toThrow(UNDO_OPEN_BALLOT_MESSAGE);
			await expectMembershipSurvives(membershipId);
			const [vote] = await testDb
				.select({ c: meetingVotes.candidateMemberId })
				.from(meetingVotes)
				.where(eq(meetingVotes.sessionId, sessionId));
			expect(vote?.c).toBe(membershipId);
		});

		it("refuses while the member is a voter on an open ballot", async () => {
			const { guestId, membershipId } = await converted("Voter Vic");
			const sessionId = await session("best_table_topics");
			await testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: membershipId,
				candidateMemberId: seed.memberId,
			});
			await expect(undo(guestId)).rejects.toThrow(UNDO_OPEN_BALLOT_MESSAGE);
			await expectMembershipSurvives(membershipId);
			const [vote] = await testDb
				.select({ v: meetingVotes.voterMemberId })
				.from(meetingVotes)
				.where(eq(meetingVotes.sessionId, sessionId));
			expect(vote?.v).toBe(membershipId);
		});

		it("still refuses when a DIFFERENT category's award is recorded", async () => {
			const { guestId, membershipId } = await converted("Other Category");
			const sessionId = await session("best_speaker");
			await award("best_table_topics");
			await testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: seed.memberId,
				candidateMemberId: membershipId,
			});
			await expect(undo(guestId)).rejects.toThrow(UNDO_OPEN_BALLOT_MESSAGE);
		});

		it("does not refuse once that ballot's award is recorded", async () => {
			const { guestId, membershipId } = await converted("Award Recorded");
			const sessionId = await session("best_speaker");
			await award("best_speaker");
			// The converted member is a VOTER; the award names someone else.
			await testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: membershipId,
				candidateMemberId: seed.memberId,
			});
			const res = await undo(guestId);
			expect(res.membershipDeleted).toBe(true);
		});

		it("still refuses when the award is recorded at a DIFFERENT meeting", async () => {
			const { guestId, membershipId } = await converted("Other Meeting");
			const sessionId = await session("best_speaker");
			const [other] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			if (!other) throw new Error("Failed to seed meeting");
			await award("best_speaker", other.id);
			await testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: membershipId,
				candidateMemberId: seed.memberId,
			});
			await expect(undo(guestId)).rejects.toThrow(UNDO_OPEN_BALLOT_MESSAGE);
			await expectMembershipSurvives(membershipId);
		});

		it("does not refuse for a vote that names other people", async () => {
			const { guestId } = await converted("Bystander");
			const sessionId = await session("best_speaker");
			await testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: seed.adminMemberId,
				candidateMemberId: seed.memberId,
			});
			const res = await undo(guestId);
			expect(res.membershipDeleted).toBe(true);
		});
	},
);

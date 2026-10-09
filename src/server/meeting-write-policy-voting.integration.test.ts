/**
 * DB-backed tests for the voting writers refusing a frozen meeting BY WRITE
 * CLASS (#1138, part of #1129).
 *
 * Every writer here is `plan` class: a cancelled and a completed meeting both
 * refuse it, with the sentence `assertMeetingAccepts` owns. Before #1138 most of
 * them refused one status or none. This file holds what became refused, and the
 * scheduled meeting each still writes:
 *
 *  - `openVote`, `closeVote`, `disqualifyCandidate`, `undoDisqualification`
 *    gained CANCELLED (their handlers in `voting.ts` already refused completed,
 *    but a handler body cannot be reached from vitest, so the refusal that is
 *    tested lives in the writer's own body);
 *  - `castVote`, `castAnonymousVote` (through `castVote`) and
 *    `joinBallotAsGuest` gained COMPLETED;
 *  - `applyMeetingDigitalVoting` gained COMPLETED.
 *
 * A completed meeting is built the way the ballot writers can actually be
 * reached on one: `meetings.status = 'completed'` set DIRECTLY with a vote
 * session left OPEN. Normal completion closes every session first, so a test
 * that completed through `applyCompleteMeeting` would hit the closed-session
 * error instead and prove nothing about the new refusal. The refusal has to run
 * BEFORE any session-state check, so every completed case also asserts it is
 * the lock sentence that comes back, not "Voting for this award is not open."
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	guests,
	meetingCandidateDisqualifications,
	meetings,
	meetingVoteSessions,
	meetingVotes,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import {
	MEETING_LOCKED_MESSAGE,
	type MeetingStatus,
} from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	castVote,
	closeVote,
	disqualifyCandidate,
	joinBallotAsGuest,
	listVoteSessions,
	openVote,
	undoDisqualification,
} = await import("#/server/voting-logic");
const {
	applyMeetingDigitalVoting,
	applyMeetingMetaPatch,
	applyWordOfTheDayUpdate,
} = await import("#/server/meetings-logic");

/** The sentence each frozen status must answer with. */
const REFUSED: readonly (readonly [
	Exclude<MeetingStatus, "scheduled">,
	string,
])[] = [
	["cancelled", MEETING_CANCELLED_MESSAGE],
	["completed", MEETING_LOCKED_MESSAGE],
];

/** The closed-window sentence a completed meeting said before #1138. */
const WINDOW_CLOSED = "Voting for this award is not open.";

const PHONE = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

describe.skipIf(!hasTestDb)(
	"voting writers refuse a frozen meeting by write class (#1138)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
			// Two eligible candidates, so a ballot has someone to name.
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					sortOrder: 99,
				})
				.returning({ id: roleDefinitions.id });
			await testDb.insert(roleSlots).values([
				{
					meetingId: seed.meetingId,
					roleDefinitionId: def.id,
					slotIndex: 0,
					assignedMemberId: seed.adminMemberId,
				},
				{
					meetingId: seed.meetingId,
					roleDefinitionId: def.id,
					slotIndex: 1,
					assignedMemberId: seed.memberId,
				},
			]);
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		/** Set the status directly, as `applyCompleteMeeting` would not leave it. */
		async function freeze(status: MeetingStatus) {
			await testDb
				.update(meetings)
				.set({ status })
				.where(eq(meetings.id, seed.meetingId));
		}

		const window = () => ({
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			category: "best_speaker" as const,
			actorMemberId: seed.adminMemberId,
		});

		const candidate = () => ({
			kind: "member" as const,
			id: seed.memberId,
		});

		const sessions = () =>
			testDb
				.select({
					id: meetingVoteSessions.id,
					closedAt: meetingVoteSessions.closedAt,
				})
				.from(meetingVoteSessions)
				.where(eq(meetingVoteSessions.meetingId, seed.meetingId));

		const rulings = () =>
			testDb
				.select({ id: meetingCandidateDisqualifications.id })
				.from(meetingCandidateDisqualifications)
				.where(eq(meetingCandidateDisqualifications.meetingId, seed.meetingId));

		const ballots = () =>
			testDb
				.select({ id: meetingVotes.id })
				.from(meetingVotes)
				.innerJoin(
					meetingVoteSessions,
					eq(meetingVotes.sessionId, meetingVoteSessions.id),
				)
				.where(eq(meetingVoteSessions.meetingId, seed.meetingId));

		const guestsOfClub = () =>
			testDb
				.select({ id: guests.id })
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));

		const activityActions = async () =>
			(
				await testDb
					.select({ action: activityLog.action })
					.from(activityLog)
					.where(eq(activityLog.clubId, seed.clubId))
			).map((r) => r.action);

		describe("the console writers", () => {
			for (const [status, message] of REFUSED) {
				describe(`on a ${status} meeting`, () => {
					it("openVote refuses with the status's sentence and opens nothing", async () => {
						await freeze(status);
						await expect(openVote(window())).rejects.toThrow(message);
						expect(await sessions()).toHaveLength(0);
						expect(await activityActions()).not.toContain("vote_open");
					});

					it("closeVote refuses and leaves the open session open", async () => {
						await openVote(window());
						await freeze(status);
						await expect(closeVote(window())).rejects.toThrow(message);
						const [session] = await sessions();
						expect(session?.closedAt).toBeNull();
						expect(await activityActions()).not.toContain("vote_close");
					});

					it("disqualifyCandidate refuses and records no ruling", async () => {
						await freeze(status);
						await expect(
							disqualifyCandidate({
								...window(),
								candidate: candidate(),
								reason: "Outside the qualifying window",
							}),
						).rejects.toThrow(message);
						expect(await rulings()).toHaveLength(0);
						expect(await activityActions()).not.toContain("vote_disqualify");
					});

					it("undoDisqualification refuses and leaves the ruling standing", async () => {
						await disqualifyCandidate({
							...window(),
							candidate: candidate(),
							reason: "Outside the qualifying window",
						});
						await freeze(status);
						await expect(
							undoDisqualification({ ...window(), candidate: candidate() }),
						).rejects.toThrow(message);
						expect(await rulings()).toHaveLength(1);
						expect(await activityActions()).not.toContain(
							"vote_disqualify_undo",
						);
					});
				});
			}

			it("a scheduled meeting still opens, closes, rules out and restores", async () => {
				await openVote(window());
				expect(
					(await listVoteSessions(seed.meetingId)).best_speaker.isOpen,
				).toBe(true);
				await closeVote(window());
				expect(
					(await listVoteSessions(seed.meetingId)).best_speaker.isOpen,
				).toBe(false);
				await disqualifyCandidate({
					...window(),
					candidate: candidate(),
					reason: "Outside the qualifying window",
				});
				expect(await rulings()).toHaveLength(1);
				await undoDisqualification({ ...window(), candidate: candidate() });
				expect(await rulings()).toHaveLength(0);
			});

			// `openVote` reads the status under a share lock on the meeting row, the
			// lock a cancel conflicts with, so the status it acts on is the status the
			// write lands on. A plain read would take the scheduled row from before the
			// cancel and open a vote on a meeting that no longer happens. The statement
			// parked below is that read: a plain SELECT is never blocked by an
			// uncommitted UPDATE, so reaching the wait IS the proof it took the lock.
			it("openVote waits for a cancel in flight and then refuses it", async () => {
				const blocker = await openBlockingTx(async (tx) => {
					await tx
						.update(meetings)
						.set({ status: "cancelled" })
						.where(eq(meetings.id, seed.meetingId));
				});
				const opening = openVote(window());
				// Claim the rejection now: a failure before the wait below must not
				// surface as an unhandled rejection, and `expect` re-reads it after.
				opening.catch(() => {});
				await waitForLockWait('select "status" from "meetings"', blocker.pid);
				await blocker.commit();
				await expect(opening).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
				expect(await sessions()).toHaveLength(0);
			});
		});

		describe("the ballot writers", () => {
			beforeEach(async () => {
				await openVote(window());
			});

			const memberBallot = () => ({
				meetingId: seed.meetingId,
				category: "best_speaker" as const,
				voter: { kind: "member" as const, id: seed.memberId },
				candidate: { kind: "member" as const, id: seed.adminMemberId },
				deviceToken: PHONE,
			});

			const anonymousBallot = () => ({
				...memberBallot(),
				voter: { kind: "anonymous" as const },
			});

			for (const [status, message] of REFUSED) {
				describe(`on a ${status} meeting with a session still open`, () => {
					beforeEach(async () => {
						await freeze(status);
						// The precondition the whole block rests on: a session left open,
						// so the closed-window error is not what refuses these.
						const [session] = await sessions();
						expect(session?.closedAt).toBeNull();
					});

					it("castVote refuses a member's ballot with the status's sentence", async () => {
						await expect(castVote(memberBallot())).rejects.toThrow(message);
						expect(await ballots()).toHaveLength(0);
					});

					it("castVote refuses an anonymous ballot, which is castAnonymousVote's path", async () => {
						await expect(castVote(anonymousBallot())).rejects.toThrow(message);
						expect(await ballots()).toHaveLength(0);
					});

					it("joinBallotAsGuest refuses and mints no guest", async () => {
						await expect(
							joinBallotAsGuest({
								meetingId: seed.meetingId,
								name: "Ada Byron",
							}),
						).rejects.toThrow(message);
						expect(await guestsOfClub()).toHaveLength(0);
					});
				});
			}

			// The refusal answers before any session-state check, so a meeting whose
			// session is already closed, or was never opened, still says why.
			it("a completed meeting with its session closed says the lock, not the closed window", async () => {
				await closeVote(window());
				await freeze("completed");
				for (const ballot of [memberBallot(), anonymousBallot()]) {
					const error = await castVote(ballot).catch((e: Error) => e);
					expect(error).toBeInstanceOf(Error);
					expect((error as Error).message).toBe(MEETING_LOCKED_MESSAGE);
					expect((error as Error).message).not.toBe(WINDOW_CLOSED);
				}
			});

			it("a completed meeting that never opened a category says the lock too", async () => {
				await testDb
					.delete(meetingVoteSessions)
					.where(eq(meetingVoteSessions.meetingId, seed.meetingId));
				await freeze("completed");
				const error = await castVote(memberBallot()).catch((e: Error) => e);
				expect((error as Error).message).toBe(MEETING_LOCKED_MESSAGE);
			});

			it("a scheduled meeting still takes a member's ballot, an anonymous one and a guest's join", async () => {
				await castVote(memberBallot());
				await castVote(anonymousBallot());
				expect(await ballots()).toHaveLength(2);
				const joined = await joinBallotAsGuest({
					meetingId: seed.meetingId,
					name: "Ada Byron",
				});
				expect(joined.name).toBe("Ada Byron");
				expect(await guestsOfClub()).toHaveLength(1);
			});
		});

		describe("applyMeetingDigitalVoting", () => {
			const switchOf = async () =>
				(
					await testDb
						.select({ disabled: meetings.digitalVotingDisabled })
						.from(meetings)
						.where(eq(meetings.id, seed.meetingId))
				)[0]?.disabled;

			for (const [status, message] of REFUSED) {
				it(`refuses a ${status} meeting and leaves the switch alone`, async () => {
					await freeze(status);
					await expect(
						applyMeetingDigitalVoting({
							meetingId: seed.meetingId,
							disabled: true,
							actorMemberId: seed.adminMemberId,
						}),
					).rejects.toThrow(message);
					expect(await switchOf()).toBe(false);
				});
			}

			it("a scheduled meeting still switches off and back on", async () => {
				await applyMeetingDigitalVoting({
					meetingId: seed.meetingId,
					disabled: true,
					actorMemberId: seed.adminMemberId,
				});
				expect(await switchOf()).toBe(true);
				await applyMeetingDigitalVoting({
					meetingId: seed.meetingId,
					disabled: false,
					actorMemberId: seed.adminMemberId,
				});
				expect(await switchOf()).toBe(false);
			});
		});

		// `updateMeetingUnlessCancelled`, the meta patch and the two narrow writers
		// are `plan` class WITH an `accept: ["completed"]` override: the completed
		// lock is enforced in front of them (the resolvers and the planner), and
		// the writer has never refused it itself. These pin the override on the two
		// empty-patch refusals, which no other test reaches with a completed meeting.
		describe("the meta writers keep accepting a completed meeting", () => {
			it("applyMeetingMetaPatch: an empty patch is a quiet success", async () => {
				await freeze("completed");
				await expect(
					applyMeetingMetaPatch({
						meetingId: seed.meetingId,
						actorMemberId: null,
					}),
				).resolves.toStrictEqual({ clubId: seed.clubId });
			});

			it("applyWordOfTheDayUpdate: an empty patch is a quiet success", async () => {
				await freeze("completed");
				await expect(
					applyWordOfTheDayUpdate({
						meetingId: seed.meetingId,
						actorMemberId: null,
					}),
				).resolves.toStrictEqual({ clubId: seed.clubId });
			});

			it("a cancelled meeting still refuses the same empty patches", async () => {
				await freeze("cancelled");
				await expect(
					applyMeetingMetaPatch({
						meetingId: seed.meetingId,
						actorMemberId: null,
					}),
				).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
				await expect(
					applyWordOfTheDayUpdate({
						meetingId: seed.meetingId,
						actorMemberId: null,
					}),
				).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			});
		});
	},
);

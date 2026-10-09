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
 *  - `applyMeetingDigitalVoting` is `plan` with `accept: ["completed"]`: it
 *    refuses a cancelled meeting, as before, and keeps accepting a completed one.
 *
 * A completed meeting is built the way the ballot writers can actually be
 * reached on one: `meetings.status = 'completed'` set DIRECTLY with a vote
 * session left OPEN. Normal completion closes every session first, so a test
 * that completed through `applyCompleteMeeting` would hit the closed-session
 * error instead and prove nothing about the new refusal. The refusal has to run
 * BEFORE any session-state check, so the completed ballot cases assert it is the
 * lock sentence that comes back.
 *
 * ORDER is pinned too, because each of these refusals answers a question that
 * another check would otherwise answer first with a different sentence: the
 * archive gate runs before the frozen check, and the frozen check runs before the
 * digital-voting switch and before the ruling's reason is validated.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	guests,
	meetingCandidateDisqualifications,
	meetings,
	meetingVoteSessions,
	meetingVotes,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { DIGITAL_VOTING_OFF_MESSAGE } from "#/lib/digital-voting";
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

const DEVICE_TOKEN = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

/**
 * The statement a locked status read parks in. A plain SELECT is never blocked
 * by an uncommitted UPDATE, so a statement matching this that waits behind a
 * cancel IS a read taken under a share lock.
 */
const STATUS_READ = 'select "status" from "meetings"';

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

		async function archiveClub() {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
		}

		async function switchMeetingOff() {
			await testDb
				.update(meetings)
				.set({ digitalVotingDisabled: true })
				.where(eq(meetings.id, seed.meetingId));
		}

		const voteWindow = () => ({
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			category: "best_speaker" as const,
			actorMemberId: seed.adminMemberId,
		});

		const candidate = () => ({
			kind: "member" as const,
			id: seed.memberId,
		});

		const ruling = () => ({
			...voteWindow(),
			candidate: candidate(),
			reason: "Outside the qualifying window",
		});

		/** `best_speaker` only: the console block opens `best_evaluator` as setup. */
		const sessions = async () =>
			(
				await testDb
					.select({
						category: meetingVoteSessions.category,
						closedAt: meetingVoteSessions.closedAt,
					})
					.from(meetingVoteSessions)
					.where(eq(meetingVoteSessions.meetingId, seed.meetingId))
			).filter((s) => s.category === "best_speaker");

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

		/** The club's activity log, sorted so two reads compare equal. */
		const activityActions = async () =>
			(
				await testDb
					.select({ action: activityLog.action })
					.from(activityLog)
					.where(eq(activityLog.clubId, seed.clubId))
			)
				.map((r) => r.action)
				.sort();

		/** The error a call rejects with, or null when it resolves. */
		const outcomeOf = (run: () => Promise<unknown>) =>
			run().then(
				() => null,
				(e: unknown) => e,
			);

		async function messageOf(run: () => Promise<unknown>) {
			const error = await outcomeOf(run);
			expect(error, "the call resolved, so nothing refused it").toBeInstanceOf(
				Error,
			);
			return (error as Error).message;
		}

		/**
		 * Run `run` while a cancel is in flight: an open transaction holds the
		 * meeting row with `status = 'cancelled'` uncommitted. `run` reads the
		 * scheduled row from before it, so anything it checks WITHOUT waiting for the
		 * row sees a meeting that is about to be cancelled. The wait below proves it
		 * parked on a locked status read, and the commit is in a `finally` so a
		 * timeout cannot leave the transaction (and its row lock) open on the shared
		 * database.
		 */
		async function acrossACancel(run: () => Promise<unknown>) {
			const blocker = await openBlockingTx(async (tx) => {
				await tx
					.update(meetings)
					.set({ status: "cancelled" })
					.where(eq(meetings.id, seed.meetingId));
			});
			const outcome = outcomeOf(run);
			try {
				await waitForLockWait(STATUS_READ, blocker.pid);
			} finally {
				await blocker.commit();
			}
			return outcome;
		}

		describe("the console writers", () => {
			let logBefore: string[];

			beforeEach(async () => {
				// A write that DOES log, in the category the cases below do not touch.
				// It is the positive anchor for every "writes no log entry" check: an
				// activity query that returned nothing at all would pass those
				// vacuously, and this makes it return something.
				await openVote({ ...voteWindow(), category: "best_evaluator" });
				logBefore = await activityActions();
				expect(logBefore).toContain("vote_open");
			});

			for (const [status, message] of REFUSED) {
				describe(`on a ${status} meeting`, () => {
					it("openVote refuses with the status's sentence and opens nothing", async () => {
						await freeze(status);
						await expect(openVote(voteWindow())).rejects.toThrow(message);
						expect(await sessions()).toHaveLength(0);
						expect(await activityActions()).toStrictEqual(logBefore);
					});

					it("closeVote refuses and leaves the open session open", async () => {
						await openVote(voteWindow());
						const logOpened = await activityActions();
						expect(logOpened).not.toStrictEqual(logBefore);
						await freeze(status);
						await expect(closeVote(voteWindow())).rejects.toThrow(message);
						const [session] = await sessions();
						expect(session?.closedAt).toBeNull();
						expect(await activityActions()).toStrictEqual(logOpened);
					});

					it("disqualifyCandidate refuses and records no ruling", async () => {
						await freeze(status);
						await expect(disqualifyCandidate(ruling())).rejects.toThrow(
							message,
						);
						expect(await rulings()).toHaveLength(0);
						expect(await activityActions()).toStrictEqual(logBefore);
					});

					it("undoDisqualification refuses and leaves the ruling standing", async () => {
						await disqualifyCandidate(ruling());
						const logRuled = await activityActions();
						expect(logRuled).toContain("vote_disqualify");
						await freeze(status);
						await expect(
							undoDisqualification({ ...voteWindow(), candidate: candidate() }),
						).rejects.toThrow(message);
						expect(await rulings()).toHaveLength(1);
						expect(await activityActions()).toStrictEqual(logRuled);
					});
				});
			}

			it("a scheduled meeting still opens, closes, rules out and restores", async () => {
				await openVote(voteWindow());
				expect(
					(await listVoteSessions(seed.meetingId)).best_speaker.isOpen,
				).toBe(true);
				await closeVote(voteWindow());
				expect(
					(await listVoteSessions(seed.meetingId)).best_speaker.isOpen,
				).toBe(false);
				await disqualifyCandidate(ruling());
				expect(await rulings()).toHaveLength(1);
				await undoDisqualification({ ...voteWindow(), candidate: candidate() });
				expect(await rulings()).toHaveLength(0);
			});

			describe("a meeting that does not exist", () => {
				// `assertVoteMeetingAccepts` has no row to judge, so it says nothing and
				// leaves the not-found answer to the caller's own lookup. The two cases
				// are the two shapes of that: a close with nothing to close is the
				// quiet no-op it always was, and a ballot names the missing meeting.
				it("closeVote is still a quiet no-op", async () => {
					await expect(
						closeVote({ ...voteWindow(), meetingId: randomUUID() }),
					).resolves.toBeUndefined();
					expect(await activityActions()).toStrictEqual(logBefore);
				});

				it("castVote still says the meeting is not found, not a policy sentence", async () => {
					await expect(
						castVote({
							meetingId: randomUUID(),
							category: "best_speaker",
							voter: { kind: "anonymous" },
							candidate: { kind: "member", id: seed.adminMemberId },
							deviceToken: DEVICE_TOKEN,
						}),
					).rejects.toThrow("Meeting not found.");
				});
			});

			// `openVote`, `disqualifyCandidate` and `undoDisqualification` read the
			// status under a share lock on the meeting row, the lock a cancel conflicts
			// with, so the status they act on is the status their write lands on. A
			// plain read would take the scheduled row from before the cancel and write
			// onto a meeting that no longer happens, which `loadTally` and `setAward`
			// then read. `acrossACancel` proves each parked on that read.
			describe("a cancel in flight", () => {
				it("openVote waits for it and then refuses", async () => {
					const error = await acrossACancel(() => openVote(voteWindow()));
					expect((error as Error | null)?.message).toBe(
						MEETING_CANCELLED_MESSAGE,
					);
					expect(await sessions()).toHaveLength(0);
					expect(await activityActions()).toStrictEqual(logBefore);
				});

				it("disqualifyCandidate waits for it and then refuses", async () => {
					const error = await acrossACancel(() =>
						disqualifyCandidate(ruling()),
					);
					expect((error as Error | null)?.message).toBe(
						MEETING_CANCELLED_MESSAGE,
					);
					expect(await rulings()).toHaveLength(0);
					expect(await activityActions()).toStrictEqual(logBefore);
				});

				it("undoDisqualification waits for it and then refuses", async () => {
					await disqualifyCandidate(ruling());
					const error = await acrossACancel(() =>
						undoDisqualification({ ...voteWindow(), candidate: candidate() }),
					);
					expect((error as Error | null)?.message).toBe(
						MEETING_CANCELLED_MESSAGE,
					);
					expect(await rulings()).toHaveLength(1);
				});
			});

			describe("order", () => {
				for (const [status] of REFUSED) {
					it(`an archived club answers before a ${status} meeting does`, async () => {
						await openVote(voteWindow());
						await freeze(status);
						await archiveClub();
						for (const write of [
							() => openVote(voteWindow()),
							() => closeVote(voteWindow()),
							() => disqualifyCandidate(ruling()),
							() =>
								undoDisqualification({
									...voteWindow(),
									candidate: candidate(),
								}),
							() =>
								castVote({
									meetingId: seed.meetingId,
									category: "best_speaker",
									voter: { kind: "anonymous" },
									candidate: { kind: "member", id: seed.adminMemberId },
									deviceToken: DEVICE_TOKEN,
								}),
						]) {
							expect(await messageOf(write)).toBe(CLUB_ARCHIVED_MESSAGE);
						}
					});

					it(`a ${status} meeting answers before the digital-voting switch does`, async () => {
						await switchMeetingOff();
						await freeze(status);
						const expected = REFUSED.find(([s]) => s === status)?.[1];
						expect(await messageOf(() => openVote(voteWindow()))).toBe(
							expected,
						);
						expect(
							await messageOf(() =>
								castVote({
									meetingId: seed.meetingId,
									category: "best_speaker",
									voter: { kind: "anonymous" },
									candidate: { kind: "member", id: seed.adminMemberId },
									deviceToken: DEVICE_TOKEN,
								}),
							),
						).toBe(expected);
					});

					it(`a ${status} meeting answers before a ruling's reason is validated`, async () => {
						await freeze(status);
						const expected = REFUSED.find(([s]) => s === status)?.[1];
						expect(
							await messageOf(() =>
								disqualifyCandidate({ ...ruling(), reason: "   " }),
							),
						).toBe(expected);
					});
				}

				it("the switch and the reason checks do answer on a scheduled meeting", async () => {
					// The control for the two cases above: with the meeting not frozen the
					// SAME inputs are refused by the check that those cases show losing the
					// race, so they were not passing because that check was missing.
					await switchMeetingOff();
					expect(await messageOf(() => openVote(voteWindow()))).toBe(
						DIGITAL_VOTING_OFF_MESSAGE,
					);
					expect(
						await messageOf(() =>
							disqualifyCandidate({ ...ruling(), reason: "   " }),
						),
					).toBe("Give a reason.");
				});
			});
		});

		describe("the ballot writers", () => {
			beforeEach(async () => {
				await openVote(voteWindow());
			});

			const memberBallot = () => ({
				meetingId: seed.meetingId,
				category: "best_speaker" as const,
				voter: { kind: "member" as const, id: seed.memberId },
				candidate: { kind: "member" as const, id: seed.adminMemberId },
				deviceToken: DEVICE_TOKEN,
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
			it("a completed meeting with its session closed says the lock", async () => {
				await closeVote(voteWindow());
				await freeze("completed");
				for (const ballot of [memberBallot(), anonymousBallot()]) {
					expect(await messageOf(() => castVote(ballot))).toBe(
						MEETING_LOCKED_MESSAGE,
					);
				}
			});

			it("a completed meeting that never opened a category says the lock too", async () => {
				await testDb
					.delete(meetingVoteSessions)
					.where(eq(meetingVoteSessions.meetingId, seed.meetingId));
				await freeze("completed");
				expect(await messageOf(() => castVote(memberBallot()))).toBe(
					MEETING_LOCKED_MESSAGE,
				);
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

		// The switch is `plan` WITH an `accept: ["completed"]` override. Switching on
		// a completed meeting changes what is shown and opens nothing, and
		// `VoteCounterPanel` (the tally and the confirm-winner control) renders only
		// while the switch is on, so refusing a completed meeting would strand a
		// tally whose switch was turned off before it completed.
		describe("applyMeetingDigitalVoting", () => {
			const switchOf = async () =>
				(
					await testDb
						.select({ disabled: meetings.digitalVotingDisabled })
						.from(meetings)
						.where(eq(meetings.id, seed.meetingId))
				)[0]?.disabled;

			const setSwitch = (disabled: boolean) =>
				applyMeetingDigitalVoting({
					meetingId: seed.meetingId,
					disabled,
					actorMemberId: seed.adminMemberId,
				});

			it("refuses a cancelled meeting and leaves the switch alone", async () => {
				await freeze("cancelled");
				await expect(setSwitch(true)).rejects.toThrow(
					MEETING_CANCELLED_MESSAGE,
				);
				expect(await switchOf()).toBe(false);
			});

			it("a completed meeting's switch stays writable, in both directions", async () => {
				await freeze("completed");
				await setSwitch(true);
				expect(await switchOf()).toBe(true);
				await setSwitch(false);
				expect(await switchOf()).toBe(false);
			});

			it("a scheduled meeting still switches off and back on", async () => {
				await setSwitch(true);
				expect(await switchOf()).toBe(true);
				await setSwitch(false);
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

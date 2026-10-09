/**
 * DB-backed integration tests for digital voting (#510).
 *
 * The constraints in this file are the feature's real safety net: one vote per
 * person per category is enforced by a unique index, not by application code,
 * and the member-XOR-guest shape by check constraints. Exercised against a live
 * Postgres identified by TEST_DATABASE_URL; the whole suite skips when unset.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	activityLog,
	clubs,
	guests,
	meetingAttendance,
	meetingBallotGuests,
	meetingCandidateDisqualifications,
	meetings,
	meetingVoteSessions,
	meetingVotes,
	members,
	roleDefinitions,
	roleSlots,
	tableTopicsSpeakers,
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

/** One phone's ballot device token, for suites whose re-votes are that same
 *  phone changing its mind (#765). */
const PHONE = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

const { GUEST_VOTE_CAST_ELSEWHERE_MESSAGE, VOTE_CAST_ELSEWHERE_MESSAGE } =
	await import("#/lib/ballot-device");
const { MEETING_LOCKED_MESSAGE } = await import("#/lib/meeting-lifecycle");

const {
	anonymousBallotLockKey,
	castVote,
	closeVote,
	disqualifyCandidate,
	joinBallotAsGuest,
	listVoteSessions,
	loadBallot,
	loadParticipation,
	loadTally,
	openVote,
	undoDisqualification,
} = await import("#/server/voting-logic");
const { applyCompleteMeeting } = await import("#/server/meetings-logic");
const { setAward } = await import("#/server/minutes-logic");

describe.skipIf(!hasTestDb)("vote table constraints (#510)", () => {
	let seed: SeededClub;
	let sessionId: string;

	beforeEach(async () => {
		seed = await seedClub();
		const [s] = await testDb
			.insert(meetingVoteSessions)
			.values({ meetingId: seed.meetingId, category: "best_speaker" })
			.returning({ id: meetingVoteSessions.id });
		sessionId = s.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("rejects a second vote from the same member in one session", async () => {
		await testDb.insert(meetingVotes).values({
			sessionId,
			voterMemberId: seed.memberId,
			candidateMemberId: seed.adminMemberId,
		});
		await expect(
			testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: seed.memberId,
				candidateMemberId: seed.adminMemberId,
			}),
		).rejects.toThrow();
	});

	it("lets many members vote in one session", async () => {
		await testDb.insert(meetingVotes).values([
			{
				sessionId,
				voterMemberId: seed.memberId,
				candidateMemberId: seed.adminMemberId,
			},
			{
				sessionId,
				voterMemberId: seed.adminMemberId,
				candidateMemberId: seed.memberId,
			},
		]);
		const rows = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(rows).toHaveLength(2);
	});

	it("lets a guest and a member both vote — the NULL arbiters do not collide", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Nguyen, Thanh" })
			.returning({ id: guests.id });
		await testDb.insert(meetingVotes).values([
			{
				sessionId,
				voterMemberId: seed.memberId,
				candidateMemberId: seed.adminMemberId,
			},
			{ sessionId, voterGuestId: g.id, candidateMemberId: seed.adminMemberId },
		]);
		const rows = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(rows).toHaveLength(2);
	});

	it("rejects a vote that is both a member and a guest", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Ada Byron" })
			.returning({ id: guests.id });
		await expect(
			testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: seed.memberId,
				voterGuestId: g.id,
				candidateMemberId: seed.adminMemberId,
			}),
		).rejects.toThrow();
	});

	it("rejects two sessions for the same meeting and category", async () => {
		await expect(
			testDb
				.insert(meetingVoteSessions)
				.values({ meetingId: seed.meetingId, category: "best_speaker" }),
		).rejects.toThrow();
	});
});

describe.skipIf(!hasTestDb)("open and close a vote (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("opens a vote and reports it open", async () => {
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		const sessions = await listVoteSessions(seed.meetingId);
		expect(sessions.best_speaker).toMatchObject({ isOpen: true });
	});

	it("closing sets closedAt and reports it closed", async () => {
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		const sessions = await listVoteSessions(seed.meetingId);
		expect(sessions.best_speaker).toMatchObject({ isOpen: false });
	});

	it("re-opening a closed vote reuses the SAME row", async () => {
		const args = {
			meetingId: seed.meetingId,
			category: "best_speaker" as const,
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		};
		await openVote(args);
		await closeVote(args);
		await openVote(args);
		const rows = await testDb
			.select()
			.from(meetingVoteSessions)
			.where(eq(meetingVoteSessions.meetingId, seed.meetingId));
		expect(rows).toHaveLength(1);
		expect(rows[0].closedAt).toBeNull();
	});

	it("opening twice is idempotent, not an error", async () => {
		const args = {
			meetingId: seed.meetingId,
			category: "best_speaker" as const,
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		};
		await openVote(args);
		await expect(openVote(args)).resolves.toBeUndefined();
	});

	it("reports every category, open or not", async () => {
		const sessions = await listVoteSessions(seed.meetingId);
		expect(Object.keys(sessions).sort()).toEqual([
			"best_evaluator",
			"best_speaker",
			"best_table_topics",
		]);
		expect(sessions.best_evaluator.isOpen).toBe(false);
	});
});

describe.skipIf(!hasTestDb)("castVote (#510)", () => {
	let seed: SeededClub;
	let speakerRoleId: string;
	// The best_speaker session's id, captured once per test so vote assertions
	// can scope to `eq(meetingVotes.sessionId, sessionId)` instead of reading the
	// whole `meeting_votes` table — ~50 DB-backed suites share one Postgres, and
	// an unscoped select risks asserting on another suite's rows (#510 review
	// finding 3).
	let sessionId: string;

	beforeEach(async () => {
		seed = await seedClub();
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
		// The admin member is the meeting's speaker, so they are the one eligible
		// candidate for best_speaker.
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
		const [session] = await testDb
			.select({ id: meetingVoteSessions.id })
			.from(meetingVoteSessions)
			.where(
				and(
					eq(meetingVoteSessions.meetingId, seed.meetingId),
					eq(meetingVoteSessions.category, "best_speaker"),
				),
			);
		sessionId = session.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const ballot = (over: Record<string, unknown> = {}) => ({
		meetingId: seed.meetingId,
		category: "best_speaker" as const,
		voter: { kind: "member" as const, id: seed.memberId },
		candidate: { kind: "member" as const, id: seed.adminMemberId },
		// The ballot sends this phone's token with every cast (#765); a re-vote
		// below is the SAME phone changing its mind.
		deviceToken: PHONE,
		...over,
	});

	it("records a vote", async () => {
		await castVote(ballot());
		const rows = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(rows).toHaveLength(1);
		expect(rows[0].candidateMemberId).toBe(seed.adminMemberId);
	});

	it("re-voting while open REPLACES the pick, it does not add a row", async () => {
		// seed.memberId needs to be an eligible best_speaker candidate too (the
		// shared beforeEach only staffs seed.adminMemberId), otherwise switching
		// the pick to them would be rejected as ineligible rather than replaced.
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: speakerRoleId,
			slotIndex: 1,
			assignedMemberId: seed.memberId,
		});
		await castVote(ballot());
		await castVote(
			ballot({ candidate: { kind: "member", id: seed.memberId } }),
		);
		const rows = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(rows).toHaveLength(1);
		expect(rows[0].candidateMemberId).toBe(seed.memberId);
	});

	it("REJECTS a vote once the window is closed", async () => {
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await expect(castVote(ballot())).rejects.toThrow(/not open/i);
		expect(
			await testDb
				.select()
				.from(meetingVotes)
				.where(eq(meetingVotes.sessionId, sessionId)),
		).toHaveLength(0);
	});

	it("REJECTS a vote for someone who is not an eligible candidate", async () => {
		// seed.memberId holds no speaker slot, so they cannot win best_speaker.
		await expect(
			castVote(ballot({ candidate: { kind: "member", id: seed.memberId } })),
		).rejects.toThrow(/not eligible/i);
	});

	it("REJECTS a voter from a DIFFERENT club", async () => {
		const other = await seedClub();
		try {
			await expect(
				castVote(ballot({ voter: { kind: "member", id: other.memberId } })),
			).rejects.toThrow(/not found in this club/i);
			expect(
				await testDb
					.select()
					.from(meetingVotes)
					.where(eq(meetingVotes.sessionId, sessionId)),
			).toHaveLength(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("REJECTS a vote into a category that was never opened", async () => {
		// The candidate must be ELIGIBLE for best_evaluator, or the eligibility
		// check (which runs before the window check — see castVote's doc comment)
		// would reject this ballot as "not eligible" and never exercise the window
		// check this test targets. So seed.adminMemberId is staffed as an
		// evaluator too, isolated to this test.
		const [evalDef] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Evaluator",
				category: "evaluator",
				sortOrder: 98,
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: evalDef.id,
			slotIndex: 0,
			assignedMemberId: seed.adminMemberId,
		});
		await expect(
			castVote(
				ballot({
					category: "best_evaluator",
					candidate: { kind: "member", id: seed.adminMemberId },
				}),
			),
		).rejects.toThrow(/not open/i);
	});

	it("lets a guest vote", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Silva, Marco" })
			.returning({ id: guests.id });
		// castVote now requires the guest to have actually joined THIS meeting's
		// ballot (#510 follow-up review finding 1a) — a bare club-scoped guest row
		// is not enough. Link it directly rather than routing through
		// `joinBallotAsGuest`, so this test stays scoped to castVote's own check.
		await testDb
			.insert(meetingBallotGuests)
			.values({ meetingId: seed.meetingId, guestId: g.id });
		await castVote(ballot({ voter: { kind: "guest", id: g.id } }));
		const rows = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(rows[0].voterGuestId).toBe(g.id);
	});

	it("REJECTS a guest voter who has not joined this meeting's ballot (#510 follow-up review finding 1a)", async () => {
		// A guest row that exists and is club-scoped — e.g. minted by the public
		// guest book, or by an officer manually assigning a guest to a role slot —
		// but was never run through `joinBallotAsGuest` for THIS meeting. Proven
		// exploit: `castVote` used to validate club membership only, so a guest id
		// from ANY surface worked as a voter, and `joinBallotAsGuest`'s per-meeting
		// cap bounded nothing as a result.
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Haddad, Layla" })
			.returning({ id: guests.id });
		await expect(
			castVote(ballot({ voter: { kind: "guest", id: g.id } })),
		).rejects.toThrow(/has not joined/i);
		expect(
			await testDb
				.select()
				.from(meetingVotes)
				.where(eq(meetingVotes.sessionId, sessionId)),
		).toHaveLength(0);
	});

	it("REJECTS a guest voter from a DIFFERENT club", async () => {
		// The guest-side twin of "REJECTS a voter from a DIFFERENT club" above —
		// the design spec requires the two-club scoping test for BOTH voter paths,
		// and only the member path had one (#510 review finding 4).
		const other = await seedClub();
		try {
			const [otherGuest] = await testDb
				.insert(guests)
				.values({ clubId: other.clubId, name: "Silva, Marco" })
				.returning({ id: guests.id });
			await expect(
				castVote(ballot({ voter: { kind: "guest", id: otherGuest.id } })),
			).rejects.toThrow(/not found in this club/i);
			expect(
				await testDb
					.select()
					.from(meetingVotes)
					.where(eq(meetingVotes.sessionId, sessionId)),
			).toHaveLength(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("allows a self-vote — deliberately not blocked", async () => {
		await castVote(
			ballot({ voter: { kind: "member", id: seed.adminMemberId } }),
		);
		expect(
			await testDb
				.select()
				.from(meetingVotes)
				.where(eq(meetingVotes.sessionId, sessionId)),
		).toHaveLength(1);
	});

	it("REJECTS a voter whose membership is INACTIVE", async () => {
		// requireMemberInMeetingClub (shared with setAward / addTableTopicsSpeaker)
		// deliberately checks club membership only, never status — a departed
		// member legitimately can still be a past meeting's award winner. The
		// voter path adds its OWN active-status check on top (#510 review
		// finding 2): a departed member's id must not be able to cast a NEW
		// ballot through this public, unauthenticated endpoint.
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.memberId));
		await expect(castVote(ballot())).rejects.toThrow(/not active/i);
		expect(
			await testDb
				.select()
				.from(meetingVotes)
				.where(eq(meetingVotes.sessionId, sessionId)),
		).toHaveLength(0);
	});

	it("does not let a cast parked on a lock apply a stale write after Close commits (race, #510)", async () => {
		// The reviewer's exploit needs an EXISTING ballot to contend on: V has
		// already voted, and their client double-fires a retry (the design
		// explicitly retries on bad wifi). seed.memberId also needs to be an
		// eligible best_speaker candidate (the shared beforeEach only staffs
		// seed.adminMemberId), so the in-flight cast below can pick a DIFFERENT
		// candidate than the one already on file — otherwise a stale write and a
		// correct no-op would be indistinguishable at the end.
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: speakerRoleId,
			slotIndex: 1,
			assignedMemberId: seed.memberId,
		});

		// V's first cast: candidate = adminMemberId. This is the row the
		// double-fire below contends on.
		await castVote(ballot());
		const [{ id: voteRowId }] = await testDb
			.select({ id: meetingVotes.id })
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));

		// Cast #2 — the double-fire. Simulated directly with a raw UPDATE rather
		// than a second `castVote` call: all it needs to contribute to the race is
		// "holds V's row lock", which this gives without a second real ballot's
		// worth of setup.
		const writer = await openBlockingTx(async (tx) => {
			await tx
				.update(meetingVotes)
				.set({ updatedAt: sql`now()` })
				.where(eq(meetingVotes.id, voteRowId));
		});

		// Cast #3 — the real code under test. Its `INSERT ... SELECT` reads the
		// session as open (it genuinely still is, at this instant), then tries to
		// lock V's row for the `ON CONFLICT DO UPDATE` and parks behind cast #2.
		const pending = castVote(
			ballot({ candidate: { kind: "member", id: seed.memberId } }),
		);
		pending.catch(() => {});
		const cast3Pid = await waitForLockWait('"meeting_votes"', writer.pid);

		// The Ballot Counter taps Close while cast #3 is parked — exactly the
		// window the exploit needs. Fired, not awaited: with `.for("share")` in
		// place this now blocks on cast #3's held share lock on the session row,
		// and awaiting it directly here would deadlock against `writer.commit()`
		// below.
		const closePending = closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		closePending.catch(() => {});

		// THE assertion: with `.for("share")`, Close cannot commit while cast #3
		// is still in flight — it has to park behind cast #3's share lock on the
		// session row. Without the fix, Close's UPDATE touches only
		// `meeting_vote_sessions`, which nothing locks, so it commits immediately
		// and this call times out (10s) waiting for a block that never happens —
		// the test fails right here.
		await waitForLockWait('"meeting_vote_sessions"', cast3Pid);

		// Release cast #2. Cast #3 wakes and finishes; only then can Close's
		// parked UPDATE proceed.
		await writer.commit();
		await Promise.all([pending, closePending]);

		const [session] = await testDb
			.select({ closedAt: meetingVoteSessions.closedAt })
			.from(meetingVoteSessions)
			.where(eq(meetingVoteSessions.id, sessionId));
		const [vote] = await testDb
			.select({
				updatedAt: meetingVotes.updatedAt,
				candidateMemberId: meetingVotes.candidateMemberId,
			})
			.from(meetingVotes)
			.where(eq(meetingVotes.id, voteRowId));

		// Cast #3 legitimately lands — it read "open" before Close even started,
		// and `.for("share")` makes Close wait for it rather than race past it.
		// What must NEVER happen is the reviewer's finding: a write timestamped
		// AFTER the session's own close. That is the literal shape of "a ballot
		// mutated after the vote closed."
		expect(session.closedAt).not.toBeNull();
		expect(vote.candidateMemberId).toBe(seed.memberId);
		expect(vote.updatedAt.getTime()).toBeLessThanOrEqual(
			session.closedAt?.getTime() ?? Number.POSITIVE_INFINITY,
		);
	});
});

/**
 * Who may CHANGE a vote (#765, ADR-0026). Member ids are public and the ballot
 * link is shared, so the voter id alone cannot decide it: the first vote fills
 * a blank, and a change is admitted only from the device that cast it or from a
 * session bound to that voting member. Guests cannot sign in, so only the
 * casting device can change a guest's vote.
 */
describe.skipIf(!hasTestDb)("castVote: device-bound change (#765)", () => {
	let seed: SeededClub;
	let sessionId: string;
	const T = "0b7c9f6e-3a1d-4c2b-8e5f-6a7b8c9d0e1f";
	const U = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

	beforeEach(async () => {
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				sortOrder: 99,
			})
			.returning({ id: roleDefinitions.id });
		// Two eligible candidates, so a change is observable as a different pick.
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
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		const [session] = await testDb
			.select({ id: meetingVoteSessions.id })
			.from(meetingVoteSessions)
			.where(
				and(
					eq(meetingVoteSessions.meetingId, seed.meetingId),
					eq(meetingVoteSessions.category, "best_speaker"),
				),
			);
		sessionId = session.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/** M (seed.memberId) votes; the first pick is the admin, a change picks M. */
	const first = (over: Record<string, unknown> = {}) => ({
		meetingId: seed.meetingId,
		category: "best_speaker" as const,
		voter: { kind: "member" as const, id: seed.memberId },
		candidate: { kind: "member" as const, id: seed.adminMemberId },
		...over,
	});
	const change = (over: Record<string, unknown> = {}) =>
		first({
			candidate: { kind: "member" as const, id: seed.memberId },
			...over,
		});

	async function rows() {
		return testDb
			.select({
				candidateMemberId: meetingVotes.candidateMemberId,
				deviceToken: meetingVotes.deviceToken,
			})
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
	}

	async function joinedGuest(name: string) {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name })
			.returning({ id: guests.id });
		await testDb
			.insert(meetingBallotGuests)
			.values({ meetingId: seed.meetingId, guestId: g.id });
		return g.id;
	}

	it("a first vote from token T records T as the casting device", async () => {
		await castVote(first({ deviceToken: T }));
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.adminMemberId, deviceToken: T },
		]);
	});

	it("the same device changes the vote with no session, and stays the owner", async () => {
		await castVote(first({ deviceToken: T }));
		await castVote(change({ deviceToken: T }));
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.memberId, deviceToken: T },
		]);
	});

	it("ANOTHER device with no session is refused, and the row is unchanged", async () => {
		await castVote(first({ deviceToken: T }));
		await expect(castVote(change({ deviceToken: U }))).rejects.toThrow(
			VOTE_CAST_ELSEWHERE_MESSAGE,
		);
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.adminMemberId, deviceToken: T },
		]);
	});

	it("the member's OWN session changes it from another device, and T stays the owner", async () => {
		await castVote(first({ deviceToken: T }));
		await castVote(
			change({ deviceToken: U, sessionUserId: seed.memberUserId }),
		);
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.memberId, deviceToken: T },
		]);
	});

	it("a session bound to a DIFFERENT member is held to the device check", async () => {
		// seed.adminUserId resolves to seed.adminMemberId — a real, active member
		// of this club, signed in, but not the voter.
		await castVote(first({ deviceToken: T }));
		await expect(
			castVote(change({ deviceToken: U, sessionUserId: seed.adminUserId })),
		).rejects.toThrow(VOTE_CAST_ELSEWHERE_MESSAGE);
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.adminMemberId, deviceToken: T },
		]);
	});

	it("a guest's vote changes only from the device that cast it", async () => {
		const g = await joinedGuest("Okafor, Chidi");
		const guestVote = (candidate: string, deviceToken: string) =>
			castVote(
				first({
					voter: { kind: "guest", id: g },
					candidate: { kind: "member", id: candidate },
					deviceToken,
				}),
			);
		await guestVote(seed.adminMemberId, T);

		await expect(guestVote(seed.memberId, U)).rejects.toThrow(
			GUEST_VOTE_CAST_ELSEWHERE_MESSAGE,
		);
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.adminMemberId, deviceToken: T },
		]);

		await guestVote(seed.memberId, T);
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.memberId, deviceToken: T },
		]);
	});

	it("a stale tab with no token casts a first vote, but cannot change it without the member's session", async () => {
		await castVote(first());
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.adminMemberId, deviceToken: null },
		]);
		// Neither no token nor any token matches a NULL owner.
		await expect(castVote(change())).rejects.toThrow(
			VOTE_CAST_ELSEWHERE_MESSAGE,
		);
		await expect(castVote(change({ deviceToken: T }))).rejects.toThrow(
			VOTE_CAST_ELSEWHERE_MESSAGE,
		);
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.adminMemberId, deviceToken: null },
		]);
		// The member's own session still can.
		await castVote(change({ sessionUserId: seed.memberUserId }));
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.memberId, deviceToken: null },
		]);
	});

	it("a closed category still says 'not open', for a first vote and for a change", async () => {
		await castVote(first({ deviceToken: T }));
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		// A change from the owning device AND from another: the window answers
		// first, so neither reads as a device refusal.
		await expect(castVote(change({ deviceToken: T }))).rejects.toThrow(
			"Voting for this award is not open.",
		);
		await expect(castVote(change({ deviceToken: U }))).rejects.toThrow(
			"Voting for this award is not open.",
		);
		// A first vote from a voter with no row yet.
		const g = await joinedGuest("Lindqvist, Maja");
		await expect(
			castVote(first({ voter: { kind: "guest", id: g }, deviceToken: U })),
		).rejects.toThrow("Voting for this award is not open.");
		expect(await rows()).toEqual([
			{ candidateMemberId: seed.adminMemberId, deviceToken: T },
		]);
	});

	it("one device's token does not own ANOTHER voter's blank", async () => {
		// Fill-a-blank is per voter: T having cast M's vote does not stop T (or
		// anyone) filling the admin's empty ballot, and the admin's row then
		// belongs to whichever device cast it.
		await castVote(first({ deviceToken: T }));
		await castVote(
			first({
				voter: { kind: "member", id: seed.adminMemberId },
				deviceToken: U,
			}),
		);
		const all = await testDb
			.select({
				voterMemberId: meetingVotes.voterMemberId,
				deviceToken: meetingVotes.deviceToken,
			})
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(all).toHaveLength(2);
		expect(
			all.find((r) => r.voterMemberId === seed.adminMemberId)?.deviceToken,
		).toBe(U);
	});
});

/**
 * Voting without identifying (#982). A phone that never said who it is votes
 * straight away: the row carries NEITHER voter id, only the casting device's
 * token. Honour system — no uniqueness on the token, so another device (or a
 * private window) is another ballot — but the same device changing its mind
 * changes its one ballot, as every identified voter's re-tap does.
 */
describe.skipIf(!hasTestDb)(
	"meeting_votes.anonymous trigger (migration 0099)",
	() => {
		let seed: SeededClub;
		let sessionId: string;

		beforeAll(async () => {
			// Push-synced test databases cannot see a trigger (CI migrates, so there it
			// is already present). Installing the shipped file's own trigger
			// statements proves that file rather than a copy of it, as the 0087 suite
			// does. ONLY those: the backfill is safe once, not on replay — against a
			// database other suites share it would mark any vote they have orphaned
			// by then as anonymous.
			const migration = readFileSync(
				resolve(__dirname, "../../drizzle/0099_vengeful_malcolm_colcord.sql"),
				"utf8",
			);
			const triggerStatements = migration
				.split("--> statement-breakpoint")
				.filter(
					(s) => /\b(FUNCTION|TRIGGER)\b/.test(s) && !/^\s*UPDATE/m.test(s),
				);
			expect(triggerStatements).toHaveLength(3);
			for (const statement of triggerStatements) {
				await testDb.execute(sql.raw(statement));
			}
		});

		beforeEach(async () => {
			seed = await seedClub();
			const [s] = await testDb
				.insert(meetingVoteSessions)
				.values({ meetingId: seed.meetingId, category: "best_speaker" })
				.returning({ id: meetingVoteSessions.id });
			sessionId = s.id;
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		const anonymousOf = async (id: string) =>
			(
				await testDb
					.select({ anonymous: meetingVotes.anonymous })
					.from(meetingVotes)
					.where(eq(meetingVotes.id, id))
			)[0]?.anonymous;

		it("marks a voterless ballot anonymous when the INSERT does not name the column", async () => {
			// What the previous container writes while the migration has run and it
			// is still serving: the pre-0099 insert, which knows no such column. A
			// DEFAULT false alone would call it identified and the new server would
			// then count the phone's next change as a second vote.
			const res = await testDb.execute(sql`
			insert into meeting_votes (session_id, candidate_member_id, device_token)
			values (${sessionId}, ${seed.adminMemberId}, ${PHONE})
			returning id`);
			expect(await anonymousOf((res.rows[0] as { id: string }).id)).toBe(true);
		});

		it("never marks a vote that names its voter anonymous, whatever the statement sends", async () => {
			const [row] = await testDb
				.insert(meetingVotes)
				.values({
					sessionId,
					voterMemberId: seed.memberId,
					candidateMemberId: seed.adminMemberId,
					anonymous: true,
				})
				.returning({ id: meetingVotes.id });
			expect(await anonymousOf(row.id)).toBe(false);
		});

		it("leaves the flag alone when a removal later nulls the voter", async () => {
			const [row] = await testDb
				.insert(meetingVotes)
				.values({
					sessionId,
					voterMemberId: seed.memberId,
					candidateMemberId: seed.adminMemberId,
				})
				.returning({ id: meetingVotes.id });
			await testDb.delete(members).where(eq(members.id, seed.memberId));
			expect(await anonymousOf(row.id)).toBe(false);
		});
	},
);

describe.skipIf(!hasTestDb)("castVote: an anonymous voter (#982)", () => {
	let seed: SeededClub;
	let sessionId: string;
	const T = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
	const U = "6f5e4d3c-2b1a-4f0e-9d8c-7b6a5f4e3d2c";

	beforeEach(async () => {
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				sortOrder: 99,
			})
			.returning({ id: roleDefinitions.id });
		// Two eligible candidates, so a change is observable as a different pick.
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
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		const [session] = await testDb
			.select({ id: meetingVoteSessions.id })
			.from(meetingVoteSessions)
			.where(
				and(
					eq(meetingVoteSessions.meetingId, seed.meetingId),
					eq(meetingVoteSessions.category, "best_speaker"),
				),
			);
		sessionId = session.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/** An anonymous ballot for the admin, from device T unless overridden. */
	const anon = (over: Record<string, unknown> = {}) => ({
		meetingId: seed.meetingId,
		category: "best_speaker" as const,
		voter: { kind: "anonymous" as const },
		candidate: { kind: "member" as const, id: seed.adminMemberId },
		deviceToken: T,
		...over,
	});

	async function rows() {
		return testDb
			.select({
				voterMemberId: meetingVotes.voterMemberId,
				voterGuestId: meetingVotes.voterGuestId,
				candidateMemberId: meetingVotes.candidateMemberId,
				deviceToken: meetingVotes.deviceToken,
			})
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
	}

	const countFor = async (memberId: string) =>
		(await loadTally(seed.meetingId)).best_speaker.results.find(
			(r) => r.kind === "member" && r.id === memberId,
		)?.count ?? 0;

	it("stores the vote with BOTH voter ids NULL, owned by the device, and counts it", async () => {
		await castVote(anon());

		expect(await rows()).toEqual([
			{
				voterMemberId: null,
				voterGuestId: null,
				candidateMemberId: seed.adminMemberId,
				deviceToken: T,
			},
		]);
		expect(await countFor(seed.adminMemberId)).toBe(1);
		const p = await loadParticipation(seed.meetingId);
		expect(p.categories.best_speaker.ballotsIn).toBe(1);
	});

	it("is counted, but never listed as a named voter on the console", async () => {
		await castVote(anon());
		await castVote({
			...anon({ deviceToken: U }),
			voter: { kind: "member", id: seed.memberId },
		});

		const t = (await loadTally(seed.meetingId)).best_speaker;
		expect(t.results.find((r) => r.id === seed.adminMemberId)?.count).toBe(2);
		// The member is named; the anonymous ballot is not a phantom "" or a
		// placeholder person, but it IS counted as anonymous.
		expect(t.anonymousCount).toBe(1);
		expect(t.voterNames).toEqual([
			(
				await testDb
					.select({ name: members.name })
					.from(members)
					.where(eq(members.id, seed.memberId))
			)[0].name,
		]);
	});

	it("two anonymous devices are two ballots — the honour system", async () => {
		await castVote(anon({ deviceToken: T }));
		await castVote(anon({ deviceToken: U }));

		expect(await rows()).toHaveLength(2);
		expect(await countFor(seed.adminMemberId)).toBe(2);
	});

	it("the same device changing its mind changes its ONE ballot, it does not add one", async () => {
		await castVote(anon());
		await castVote(anon({ candidate: { kind: "member", id: seed.memberId } }));

		expect(await rows()).toEqual([
			{
				voterMemberId: null,
				voterGuestId: null,
				candidateMemberId: seed.memberId,
				deviceToken: T,
			},
		]);
		expect(await countFor(seed.adminMemberId)).toBe(0);
		expect(await countFor(seed.memberId)).toBe(1);
	});

	it("two simultaneous casts from one device still leave one ballot", async () => {
		// A double-tap, or a request retried on bad wifi, with NO row yet — the
		// case no row lock can cover. Made deterministic the way the #510 race
		// tests are: a writer holds this device's lock, BOTH casts are proven
		// parked on it (so both have already read the session as open and
		// neither has looked for its row), and only then is it released. The
		// casts must then run one after the other: the second finds the first's
		// row and updates it. Without the lock neither parks, and this fails at
		// the wait below.
		const writer = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${anonymousBallotLockKey(sessionId, T)}, 0))`,
			);
		});
		const a = castVote(anon());
		a.catch(() => {});
		const aPid = await waitForLockWait("pg_advisory_xact_lock", writer.pid);
		const b = castVote(
			anon({ candidate: { kind: "member", id: seed.memberId } }),
		);
		b.catch(() => {});
		// B is queued behind the writer too (and behind A once it holds the key).
		const deadline = Date.now() + 10_000;
		for (;;) {
			const res = await testDb.execute(sql`
				select count(*)::int as n from pg_stat_activity
				where datname = current_database()
				  and wait_event_type = 'Lock'
				  and query ilike '%pg_advisory_xact_lock%'
				  and pid <> ${aPid}
				  and ${writer.pid} = any(pg_blocking_pids(pid))`);
			if ((res.rows[0] as { n: number }).n > 0) break;
			if (Date.now() > deadline) throw new Error("second cast never parked");
			await new Promise((r) => setTimeout(r, 25));
		}

		await writer.commit();
		await Promise.all([a, b]);

		expect(await rows()).toHaveLength(1);
	});

	it("never touches an IDENTIFIED vote cast earlier from the same device", async () => {
		await castVote({
			...anon({ candidate: { kind: "member", id: seed.memberId } }),
			voter: { kind: "member", id: seed.memberId },
		});
		await castVote(anon());

		const all = await rows();
		expect(all).toHaveLength(2);
		expect(all.find((r) => r.voterMemberId === seed.memberId)).toMatchObject({
			candidateMemberId: seed.memberId,
		});
		expect(all.find((r) => r.voterMemberId === null)).toMatchObject({
			candidateMemberId: seed.adminMemberId,
		});
	});

	it("never touches that identified vote once its voter is removed and its voter ids go NULL", async () => {
		// Same phone, two ballots: the member's own for the member, and an
		// anonymous one for the admin.
		await castVote({
			...anon({ candidate: { kind: "member", id: seed.memberId } }),
			voter: { kind: "member", id: seed.memberId },
		});
		await castVote(anon());
		// Removing the voter mid-vote SET NULLs `voter_member_id`, leaving a row
		// with both voter ids NULL and device T — the anonymous ballot's shape.
		// The slot the removed member held goes too (its candidate is SET NULL),
		// so the vote is re-pointed at the admin's rival by hand afterwards.
		await testDb.delete(members).where(eq(members.id, seed.memberId));
		const [orphan] = await testDb
			.update(meetingVotes)
			.set({ candidateMemberId: seed.adminMemberId })
			.where(
				and(
					eq(meetingVotes.sessionId, sessionId),
					eq(meetingVotes.anonymous, false),
				),
			)
			.returning({ id: meetingVotes.id });
		expect(orphan).toBeDefined();

		// The anonymous ballot changes its mind. Only IT may move: matching on
		// "both voter ids NULL" moved the orphaned identified vote as well, so
		// one tap from this phone took two votes off the admin.
		const writeIn = "Table Topics Tam";
		await castVote(anon({ candidate: { kind: "writeIn", name: writeIn } }));

		const all = await testDb
			.select({
				id: meetingVotes.id,
				candidateMemberId: meetingVotes.candidateMemberId,
				candidateWriteIn: meetingVotes.candidateWriteIn,
			})
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(all).toHaveLength(2);
		expect(all.find((r) => r.id === orphan.id)).toMatchObject({
			candidateMemberId: seed.adminMemberId,
			candidateWriteIn: null,
		});
		expect(all.find((r) => r.id !== orphan.id)).toMatchObject({
			candidateMemberId: null,
			candidateWriteIn: writeIn,
		});
	});

	it("creates no guest and no ballot-guest link, so guest counts are unchanged", async () => {
		const guestsIn = async () =>
			(
				await testDb
					.select({ n: sql<number>`count(*)::int` })
					.from(guests)
					.where(eq(guests.clubId, seed.clubId))
			)[0].n;
		const linksIn = async () =>
			(
				await testDb
					.select({ n: sql<number>`count(*)::int` })
					.from(meetingBallotGuests)
					.where(eq(meetingBallotGuests.meetingId, seed.meetingId))
			)[0].n;
		const [g0, l0] = [await guestsIn(), await linksIn()];

		await castVote(anon({ deviceToken: T }));
		await castVote(anon({ deviceToken: U }));

		expect(await guestsIn()).toBe(g0);
		expect(await linksIn()).toBe(l0);
	});

	it("REJECTS an anonymous vote with no device token, and writes nothing", async () => {
		await expect(castVote(anon({ deviceToken: null }))).rejects.toThrow(
			/refresh the page/,
		);
		expect(await rows()).toEqual([]);
	});

	it("REJECTS an anonymous vote once the window is closed", async () => {
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await expect(castVote(anon())).rejects.toThrow(
			"Voting for this award is not open.",
		);
		expect(await rows()).toEqual([]);
	});

	it("REJECTS an anonymous vote for someone who is not an eligible candidate", async () => {
		// No speaker slot anywhere: a hand-crafted POST naming an arbitrary id.
		await expect(
			castVote(
				anon({
					candidate: {
						kind: "member",
						id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
					},
				}),
			),
		).rejects.toThrow("That person is not eligible for this award.");
		expect(await rows()).toEqual([]);
	});

	it("does not let an anonymous change land after Close commits (race, #510)", async () => {
		// Same shape as the identified arm's race test: an existing anonymous
		// ballot, a writer holding its row lock, and a change from the same device
		// parked behind it while the Ballot Counter taps Close.
		await castVote(anon());
		const [{ id: voteRowId }] = await testDb
			.select({ id: meetingVotes.id })
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		const writer = await openBlockingTx(async (tx) => {
			await tx
				.update(meetingVotes)
				.set({ updatedAt: sql`now()` })
				.where(eq(meetingVotes.id, voteRowId));
		});

		const pending = castVote(
			anon({ candidate: { kind: "member", id: seed.memberId } }),
		);
		pending.catch(() => {});
		const castPid = await waitForLockWait('"meeting_votes"', writer.pid);

		const closePending = closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		closePending.catch(() => {});
		// Close must wait on the cast's share lock on the session row, held for
		// the cast's whole transaction.
		await waitForLockWait('"meeting_vote_sessions"', castPid);

		await writer.commit();
		await Promise.all([pending, closePending]);

		const [session] = await testDb
			.select({ closedAt: meetingVoteSessions.closedAt })
			.from(meetingVoteSessions)
			.where(eq(meetingVoteSessions.id, sessionId));
		const [vote] = await testDb
			.select({
				updatedAt: meetingVotes.updatedAt,
				candidateMemberId: meetingVotes.candidateMemberId,
			})
			.from(meetingVotes)
			.where(eq(meetingVotes.id, voteRowId));
		expect(session.closedAt).not.toBeNull();
		expect(vote.candidateMemberId).toBe(seed.memberId);
		expect(vote.updatedAt.getTime()).toBeLessThanOrEqual(
			session.closedAt?.getTime() ?? Number.POSITIVE_INFINITY,
		);
	});
});

describe.skipIf(!hasTestDb)("ballot and tally reads (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
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
			roleDefinitionId: def.id,
			slotIndex: 0,
			assignedMemberId: seed.adminMemberId,
		});
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const open = (category: "best_speaker" | "best_evaluator") =>
		openVote({
			meetingId: seed.meetingId,
			category,
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});

	it("offers candidates only for OPEN categories", async () => {
		await open("best_speaker");
		const b = await loadBallot(seed.meetingId);
		expect(b.categories.best_speaker.isOpen).toBe(true);
		expect(b.categories.best_speaker.candidates).toHaveLength(1);
		expect(b.categories.best_evaluator.isOpen).toBe(false);
		expect(b.categories.best_evaluator.candidates).toEqual([]);
	});

	// #510 review finding 2. `isOpen` alone cannot tell a category the Ballot
	// Counter has just closed apart from one nobody has ever touched — both
	// read `false` — and the public ballot used that alone to decide whether to
	// show a category at all, so the room's phones fell back to "Voting isn't
	// open yet" the moment the last vote closed. `hasOpened` is the signal that
	// lets the client say "Voting closed" instead.
	it("marks a closed category hasOpened, distinct from one never opened", async () => {
		await open("best_speaker");
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		const b = await loadBallot(seed.meetingId);
		expect(b.categories.best_speaker.isOpen).toBe(false);
		expect(b.categories.best_speaker.hasOpened).toBe(true);
		// best_table_topics was never opened at all in this test.
		expect(b.categories.best_table_topics.isOpen).toBe(false);
		expect(b.categories.best_table_topics.hasOpened).toBe(false);
	});

	it("carries no contact details", async () => {
		await testDb.insert(guests).values({
			clubId: seed.clubId,
			name: "Haddad, Layla",
			email: "layla@example.com",
			phone: "+15559876543",
		});
		await open("best_speaker");
		const b = await loadBallot(seed.meetingId);
		expect(JSON.stringify(b)).not.toContain("layla@example.com");
		expect(JSON.stringify(b)).not.toContain("5559876543");
	});

	it("tallies counts per candidate", async () => {
		await open("best_speaker");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "member", id: seed.adminMemberId },
		});
		const t = await loadTally(seed.meetingId);
		expect(t.best_speaker.results[0]).toMatchObject({
			id: seed.adminMemberId,
			count: 1,
		});
		expect(t.best_speaker.voterNames).toHaveLength(1);
		// A named voter is not also counted as anonymous (#982).
		expect(t.best_speaker.anonymousCount).toBe(0);
	});

	it("the tally reports WHO voted but never WHAT they voted for", async () => {
		await open("best_speaker");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "member", id: seed.adminMemberId },
		});
		const t = await loadTally(seed.meetingId);
		const serialized = JSON.stringify(t.best_speaker.voterNames);
		expect(serialized).not.toContain(seed.adminMemberId);
		expect(serialized).not.toContain(seed.memberId);
	});

	it("participation reports a bare count, never per-candidate numbers", async () => {
		await open("best_speaker");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "member", id: seed.adminMemberId },
		});
		const p = await loadParticipation(seed.meetingId);
		expect(p.categories.best_speaker).toEqual({ ballotsIn: 1 });
	});

	it("has no denominator until attendance is actually marked", async () => {
		await open("best_speaker");
		const before = await loadParticipation(seed.meetingId);
		expect(before.presentCount).toBeNull();

		await testDb.insert(meetingAttendance).values({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
		});
		const after = await loadParticipation(seed.meetingId);
		expect(after.presentCount).toBe(1);
	});

	// #510 follow-up review finding 3 — `setMemberPresence` upserts per toggle,
	// so the FIRST attendance row a meeting ever gets can just as easily be an
	// ABSENT mark as a present one. The old code gated the denominator on "does
	// any attendance row exist", so this exact state — one row, marked absent —
	// rendered as `presentCount: 0` and the badge read "7 of 0 present have
	// voted". `presentCount` must stay null until there is an actual positive
	// count, matching the documented "null means no honest denominator yet".
	it('stays null when the only marked attendance is ABSENT — never "N of 0"', async () => {
		await open("best_speaker");
		await testDb.insert(meetingAttendance).values({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "absent",
		});
		const p = await loadParticipation(seed.meetingId);
		expect(p.presentCount).toBeNull();
	});
});

describe.skipIf(!hasTestDb)("completing a meeting closes voting (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		// seedClub schedules the meeting 7 days in the future; applyCompleteMeeting
		// guards on meetingDateReached, so pull it into the past before completing.
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
			.where(eq(meetings.id, seed.meetingId));
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("force-closes an open vote", async () => {
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await applyCompleteMeeting({
			meetingId: seed.meetingId,
			actorMemberId: seed.adminMemberId,
		});
		const sessions = await listVoteSessions(seed.meetingId);
		expect(sessions.best_speaker.isOpen).toBe(false);
	});

	it("completing a meeting with no votes at all does not throw", async () => {
		await expect(
			applyCompleteMeeting({
				meetingId: seed.meetingId,
				actorMemberId: seed.adminMemberId,
			}),
		).resolves.toMatchObject({ clubId: seed.clubId });
	});

	it("the tally is STILL readable once the meeting is completed", async () => {
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await applyCompleteMeeting({
			meetingId: seed.meetingId,
			actorMemberId: seed.adminMemberId,
		});
		const t = await loadTally(seed.meetingId);
		expect(t.best_speaker.isOpen).toBe(false);
		expect(Array.isArray(t.best_speaker.results)).toBe(true);
	});

	it("the winner can STILL be confirmed after the meeting is locked", async () => {
		// This is the whole reason `resolveVoteCounterAuthz` does not assert the
		// meeting lock. `setAward` is deliberately unlocked (minutes are written up
		// afterwards); if the authz layer asserted, the Ballot Counter could never
		// set a winner from the final tally.
		await applyCompleteMeeting({
			meetingId: seed.meetingId,
			actorMemberId: seed.adminMemberId,
		});
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.adminMemberId,
			}),
		).resolves.toBeUndefined();
	});

	it("REJECTS opening a vote on a completed meeting", async () => {
		await applyCompleteMeeting({
			meetingId: seed.meetingId,
			actorMemberId: seed.adminMemberId,
		});
		// `openVote` refuses it in its own body since #1138 (the server fn also
		// refuses it, but a handler cannot be reached from vitest).
		await expect(
			openVote({
				meetingId: seed.meetingId,
				category: "best_speaker",
				actorMemberId: seed.adminMemberId,
				clubId: seed.clubId,
			}),
		).rejects.toThrow(MEETING_LOCKED_MESSAGE);
	});
});

describe.skipIf(!hasTestDb)("joinBallotAsGuest (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("creates a guest and returns its id and name", async () => {
		const g = await joinBallotAsGuest({
			meetingId: seed.meetingId,
			name: "  Osei, Kwame  ",
		});
		expect(g.name).toBe("Osei, Kwame");
		const [row] = await testDb.select().from(guests).where(eq(guests.id, g.id));
		expect(row.clubId).toBe(seed.clubId);
	});

	it("rejects an empty name", async () => {
		await expect(
			joinBallotAsGuest({ meetingId: seed.meetingId, name: "   " }),
		).rejects.toThrow(/name/i);
	});

	it("caps a very long name by CODE POINT, not by UTF-16 unit", async () => {
		// Every one of these is a surrogate pair. A `.slice(0, 200)` would cut one
		// in half and emit a lone surrogate; `cap` counts code points (#522).
		const g = await joinBallotAsGuest({
			meetingId: seed.meetingId,
			name: "😀".repeat(500),
		});
		const [row] = await testDb.select().from(guests).where(eq(guests.id, g.id));
		expect([...row.name]).toHaveLength(80);
		expect(row.name).not.toMatch(/[\uD800-\uDFFF]$/);
	});

	it("refuses to create more than the per-meeting guest cap", async () => {
		for (let i = 0; i < 60; i++) {
			await joinBallotAsGuest({
				meetingId: seed.meetingId,
				name: `Visitor ${i}`,
			});
		}
		await expect(
			joinBallotAsGuest({ meetingId: seed.meetingId, name: "One too many" }),
		).rejects.toThrow(/too many/i);
	});

	// #510 review finding 1 (BLOCKING) — a serial loop, including the test right
	// above this one, cannot distinguish a real cap from a TOCTOU: check-then-write
	// always looks right when nothing else is running. The old code read the
	// pre-insert count OUTSIDE any transaction and took no lock, so 200 concurrent
	// requests all read the same count and all landed. This fires a real burst.
	it("a concurrent burst cannot exceed the cap (race, #510 review finding 1)", async () => {
		const attempts = Array.from({ length: 120 }, (_, i) =>
			joinBallotAsGuest({ meetingId: seed.meetingId, name: `Burst ${i}` }),
		);
		const results = await Promise.allSettled(attempts);
		const accepted = results.filter((r) => r.status === "fulfilled").length;
		const rejected = results.filter((r) => r.status === "rejected").length;
		// Every rejection must be the cap's own message — a connection error or an
		// unrelated throw here would make "accepted <= 60" true for the wrong
		// reason.
		for (const r of results) {
			if (r.status === "rejected") {
				expect((r.reason as Error).message).toMatch(/too many/i);
			}
		}
		expect(accepted + rejected).toBe(120);
		// The lock makes this deterministic, not just bounded: with 120 distinct
		// names against a cap of 60, exactly 60 must win.
		expect(accepted).toBe(60);

		const rows = await testDb
			.select()
			.from(meetingBallotGuests)
			.where(eq(meetingBallotGuests.meetingId, seed.meetingId));
		expect(rows).toHaveLength(60);
	});

	// #510 review finding 2 (HIGH) — the spec's "Identify" surface has a guest
	// pick from the meeting's existing guest list or add themselves; this
	// endpoint only implements the free-text add half, so it must at least
	// find-or-create rather than always-create, or a repeat submission (a second
	// tab, a retried request on bad wifi, an incognito window) mints a second
	// ballot identity with no unique index to stop it.
	describe("find-or-create (#510 review finding 2)", () => {
		it("joining twice with the same name reuses the guest — one row, one ballot identity", async () => {
			const first = await joinBallotAsGuest({
				meetingId: seed.meetingId,
				name: "Nguyen, Thanh",
			});
			const second = await joinBallotAsGuest({
				meetingId: seed.meetingId,
				name: "Nguyen, Thanh",
			});
			expect(second.id).toBe(first.id);

			const guestRows = await testDb
				.select()
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(guestRows).toHaveLength(1);

			const linkRows = await testDb
				.select()
				.from(meetingBallotGuests)
				.where(eq(meetingBallotGuests.meetingId, seed.meetingId));
			expect(linkRows).toHaveLength(1);
		});

		it("reuses a match that differs only in case or surrounding whitespace", async () => {
			const first = await joinBallotAsGuest({
				meetingId: seed.meetingId,
				name: "Nguyen, Thanh",
			});
			const second = await joinBallotAsGuest({
				meetingId: seed.meetingId,
				name: "  nguyen, THANH  ",
			});
			expect(second.id).toBe(first.id);
			// The originally-stored casing wins — the second submission does not
			// overwrite the guest's display name.
			expect(second.name).toBe(first.name);

			const guestRows = await testDb
				.select()
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(guestRows).toHaveLength(1);
		});

		it("reuses a club guest not yet on this meeting's ballot — e.g. one recorded from Table Topics", async () => {
			const [preexisting] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name: "Silva, Marco" })
				.returning({ id: guests.id, name: guests.name });

			const joined = await joinBallotAsGuest({
				meetingId: seed.meetingId,
				name: "silva, marco",
			});
			expect(joined.id).toBe(preexisting.id);

			const guestRows = await testDb
				.select()
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(guestRows).toHaveLength(1);

			const linkRows = await testDb
				.select()
				.from(meetingBallotGuests)
				.where(eq(meetingBallotGuests.meetingId, seed.meetingId));
			expect(linkRows).toHaveLength(1);
		});

		// The ALREADY-linked case: "Visitor 0" was created AND linked to this
		// meeting by the fill loop below, so re-identifying as them must stay free
		// even once the cap is full — that is a returning voter, not a new
		// identity. Contrast with the NOT-yet-linked case right after this test,
		// which the cap must still catch (#510 follow-up review finding 1b).
		it("re-joining as an ALREADY-linked guest does not consume cap headroom", async () => {
			for (let i = 0; i < 60; i++) {
				await joinBallotAsGuest({
					meetingId: seed.meetingId,
					name: `Visitor ${i}`,
				});
			}
			// The cap is full. Re-identifying as someone already on the ballot must
			// still succeed — an already-linked reuse is not gated by the cap.
			await expect(
				joinBallotAsGuest({ meetingId: seed.meetingId, name: "Visitor 0" }),
			).resolves.toMatchObject({ name: "Visitor 0" });
			// A genuinely new name is still refused.
			await expect(
				joinBallotAsGuest({ meetingId: seed.meetingId, name: "One too many" }),
			).rejects.toThrow(/too many/i);
		});

		// #510 follow-up review finding 1b — the proven hole. The OLD code counted
		// the cap only against brand-new `guests` inserts, so the reuse path
		// (any match against an EXISTING club guest, e.g. one the public guest
		// book already created) skipped the count entirely. That is exactly how
		// 70 public guest-book posts became 70 accepted `joinBallot` calls against
		// a cap of 60: every one of those 70 names already existed in `guests`
		// with no link to this meeting yet, so every one took the reuse path.
		// This guest is club-scoped and pre-existing but has NEVER been linked to
		// THIS meeting — the fix must count it exactly like a brand-new name.
		it("a reuse match NOT yet linked to this meeting still consumes cap headroom, and is refused once full", async () => {
			const [preexisting] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name: "Okonkwo, Chidi" })
				.returning({ id: guests.id, name: guests.name });

			for (let i = 0; i < 60; i++) {
				await joinBallotAsGuest({
					meetingId: seed.meetingId,
					name: `Visitor ${i}`,
				});
			}
			// The cap is full with 60 links. This guest exists but is not yet ON
			// this meeting's ballot — under the fix, that is a NEW link, so it must
			// be refused exactly like a brand-new name would be.
			await expect(
				joinBallotAsGuest({
					meetingId: seed.meetingId,
					name: "okonkwo, chidi",
				}),
			).rejects.toThrow(/too many/i);

			// No link was created for the reuse attempt that was refused — the cap
			// stayed at exactly 60, not 61.
			const linkRows = await testDb
				.select()
				.from(meetingBallotGuests)
				.where(eq(meetingBallotGuests.meetingId, seed.meetingId));
			expect(linkRows).toHaveLength(60);
			const linkedGuestIds = new Set(linkRows.map((r) => r.guestId));
			expect(linkedGuestIds.has(preexisting.id)).toBe(false);
		});

		// #510 follow-up review finding 2 (ADR-0018). `listClubGuests` already
		// excludes a converted guest (`stage: joined`, `converted_membership_id`
		// set) from the assign picker because "a joined guest is a member"; the
		// ballot's reuse match must apply the same rule, or the member that guest
		// became can type their OWN former guest name into the join box, get the
		// retired guest id handed back, and cast a SECOND ballot under it — the
		// member and guest voter arbiters are separate unique indexes, so nothing
		// else would catch that.
		it("does not reuse a CONVERTED guest — typing their name mints a fresh identity instead", async () => {
			const [converted] = await testDb
				.insert(guests)
				.values({
					clubId: seed.clubId,
					name: "Fischer, Anna",
					stage: "joined",
					convertedMembershipId: seed.adminMemberId,
				})
				.returning({ id: guests.id });

			const joined = await joinBallotAsGuest({
				meetingId: seed.meetingId,
				name: "fischer, anna",
			});
			// A DIFFERENT id — the converted row was never eligible for reuse, so
			// this minted a brand-new guest rather than handing the old one back.
			expect(joined.id).not.toBe(converted.id);

			const guestRows = await testDb
				.select()
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(guestRows).toHaveLength(2);

			// The new identity IS linked to this meeting's ballot — it is a normal
			// new voter, just not the converted one.
			const linkRows = await testDb
				.select()
				.from(meetingBallotGuests)
				.where(eq(meetingBallotGuests.meetingId, seed.meetingId));
			expect(linkRows.map((r) => r.guestId)).toEqual([joined.id]);
		});
	});
});

/**
 * Free-text write-in candidates (#582).
 *
 * The feature exists because the ballot could previously only offer people who
 * already had a row, and Table Topics respondents are not keyed in while the
 * segment runs — nobody is operating the app during a meeting, they are
 * watching it. So Best Table Topics, the category that most needs a ballot,
 * routinely opened with nobody on it.
 *
 * These run against a live Postgres because the two things most likely to be
 * wrong are a check constraint and an upsert, and neither is visible in a unit
 * test.
 */
describe.skipIf(!hasTestDb)("write-in candidates (#582)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		await openVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/** A second roster member, so "two voters pick the same person" is testable.
	 *  One vote per member per category is a unique index, so the same voter
	 *  casting twice would be an UPDATE, not a second vote. */
	async function insertMember(clubId: string, name: string): Promise<string> {
		const personId = await seedPerson({ name });
		const [row] = await testDb
			.insert(members)
			.values({ clubId, personId, name, clubRole: "member", status: "active" })
			.returning({ id: members.id });
		return row.id;
	}

	/** Votes for THIS meeting only. An unscoped `select().from(meetingVotes)`
	 *  sees every other suite's rows in the shared test database — which is how
	 *  these assertions first "failed", against another test's Bob Smith. */
	const myVotes = () =>
		testDb
			.select({
				m: meetingVotes.candidateMemberId,
				g: meetingVotes.candidateGuestId,
				w: meetingVotes.candidateWriteIn,
			})
			.from(meetingVotes)
			.innerJoin(
				meetingVoteSessions,
				eq(meetingVoteSessions.id, meetingVotes.sessionId),
			)
			.where(eq(meetingVoteSessions.meetingId, seed.meetingId));

	const castWriteIn = (name: string, voterId?: string) =>
		castVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			voter: { kind: "member", id: voterId ?? seed.memberId },
			candidate: { kind: "writeIn", name },
			// One phone throughout, so a change is the owning device's (#765).
			deviceToken: PHONE,
		});

	it("records a vote for someone who has no member or guest row", () => {
		return expect(castWriteIn("Rehanna Khan")).resolves.toBeUndefined();
	});

	it("stores the name and leaves both candidate FKs null", async () => {
		await castWriteIn("Rehanna Khan");
		expect(await myVotes()).toEqual([{ m: null, g: null, w: "Rehanna Khan" }]);
	});

	it("trims on the way in", async () => {
		await castWriteIn("   Rehanna Khan  ");
		expect((await myVotes())[0].w).toBe("Rehanna Khan");
	});

	it("rejects a name past the cap rather than storing a truncated one", async () => {
		await expect(castWriteIn("a".repeat(500))).rejects.toThrow();
		expect(await myVotes()).toHaveLength(0);
	});

	it("rejects a blank name", async () => {
		await expect(castWriteIn("    ")).rejects.toThrow();
		expect(await myVotes()).toHaveLength(0);
	});

	it("still refuses a vote when the category is closed", async () => {
		// The write-in arm skips `isEligibleCandidate`, so it must not also skip
		// the open-window check — that would make it the one way to cast into a
		// closed vote.
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await expect(castWriteIn("Rehanna Khan")).rejects.toThrow(/not open/i);
	});

	/**
	 * The dedup mechanism, end to end: a cast write-in comes BACK as a tappable
	 * candidate, so the second voter for the same person taps rather than
	 * retypes. Nothing matches names after the fact — the ballot just makes
	 * retyping unnecessary.
	 */
	it("offers a cast write-in back to later voters", async () => {
		await castWriteIn("Rehanna Khan");
		const ballot = await loadBallot(seed.meetingId);
		expect(ballot.categories.best_table_topics.candidates).toContainEqual({
			kind: "writeIn",
			id: "rehanna khan",
			name: "Rehanna Khan",
			// #723 stamps every candidate, write-ins included. Asserted as part of
			// the whole shape rather than waived: the ballot renders this field, so
			// a write-in that quietly stopped carrying it would render as ruled out
			// or crash, depending on the consumer.
			disqualified: null,
		});
	});

	it("keeps the FIRST spelling as the display form", async () => {
		const second = await insertMember(seed.clubId, "Second Voter");
		await castWriteIn("Rehanna Khan");
		await castWriteIn("rehanna   khan", second);
		const offered = (await loadBallot(seed.meetingId)).categories
			.best_table_topics.candidates;
		// ONE candidate, spelled the way the first voter typed it. Nobody should
		// see their own name lowercased on the awards slide because they happened
		// to be the second person voted for.
		expect(offered.filter((c) => c.kind === "writeIn")).toEqual([
			{
				kind: "writeIn",
				id: "rehanna khan",
				name: "Rehanna Khan",
				disqualified: null,
			},
		]);
	});

	it("counts case and spacing variants as one candidate in the tally", async () => {
		const second = await insertMember(seed.clubId, "Second Voter");
		const third = await insertMember(seed.clubId, "Third Voter");
		await castWriteIn("Rehanna Khan");
		await castWriteIn("rehanna khan", second);
		await castWriteIn("  REHANNA   KHAN ", third);
		const tally = await loadTally(seed.meetingId);
		const writeIns = tally.best_table_topics.results.filter(
			(r) => r.kind === "writeIn",
		);
		expect(writeIns).toEqual([
			{ kind: "writeIn", id: "rehanna khan", name: "Rehanna Khan", count: 3 },
		]);
	});

	it("keeps genuinely different people apart", async () => {
		const second = await insertMember(seed.clubId, "Second Voter");
		await castWriteIn("Bob Smith");
		await castWriteIn("Bob Smyth", second);
		const writeIns = (await loadTally(seed.meetingId)).best_table_topics.results
			.filter((r) => r.kind === "writeIn")
			.map((r) => r.name)
			.sort();
		expect(writeIns).toEqual(["Bob Smith", "Bob Smyth"]);
	});

	it("keeps one vote per voter when they switch from a write-in to a roster name", async () => {
		// The upsert has to CLEAR `candidate_write_in`, not just set the FK —
		// otherwise the row carries two candidates and trips the at-most-one check.
		await castWriteIn("Rehanna Khan");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "writeIn", name: "Someone Else" },
			deviceToken: PHONE,
		});
		expect(await myVotes()).toEqual([{ m: null, g: null, w: "Someone Else" }]);
	});

	it("withholds write-ins from a closed category, like every other candidate", async () => {
		await castWriteIn("Rehanna Khan");
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		const ballot = await loadBallot(seed.meetingId);
		expect(ballot.categories.best_table_topics.candidates).toEqual([]);
	});

	/**
	 * The objection that made the free-text column a real decision rather than a
	 * formality: a write-in can WIN, and `meeting_awards` is what the minutes,
	 * the emailed minutes, the minutes PDF and the printed awards beat all read.
	 * Without a column there, the winner had nowhere to live; without the name in
	 * `loadMinutes`' coalesce, it lived there and rendered blank.
	 */
	it("can be crowned, and the minutes render the name", async () => {
		await castWriteIn("Rehanna Khan");
		await setAward({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			writeInName: "Rehanna Khan",
		});
		const { loadMinutes } = await import("#/server/minutes-logic");
		const minutes = await loadMinutes(seed.meetingId);
		const award = minutes.awards.find(
			(a) => a.category === "best_table_topics",
		);
		expect(award).toMatchObject({
			name: "Rehanna Khan",
			memberId: null,
			guestId: null,
			isGuest: false,
		});
	});

	it("does not leave both a winner FK and a write-in set when a winner is changed", async () => {
		await setAward({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			writeInName: "Rehanna Khan",
		});
		await setAward({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			memberId: seed.memberId,
		});
		const { meetingAwards } = await import("#/db/schema");
		const [row] = await testDb
			.select({
				m: meetingAwards.memberId,
				w: meetingAwards.writeInName,
			})
			.from(meetingAwards)
			.where(eq(meetingAwards.meetingId, seed.meetingId));
		expect(row).toEqual({ m: seed.memberId, w: null });
	});
});

/**
 * Candidate disqualification (#723).
 *
 * A speaker can have spoken and still be unable to win — they ran outside the
 * qualifying window, or never used the Word of the Day. The ruling is a human
 * judgement the Vote Counter makes and the app records; what these tests pin is
 * that recording it actually STOPS the vote rather than only hiding a button,
 * and that undoing it puts everything back with no compensating write.
 *
 * AUTHORIZATION is proved in the two layers this repo splits it into, neither
 * of them here: `voting-authz.guard.test.ts` proves `disqualifyCandidateFn` /
 * `undoDisqualificationFn` call `requireVoteCounter` at all (a `createServerFn`
 * cannot be invoked from vitest), and `vote-counter-capability.integration.test.ts`
 * proves the decision that gate makes. This file exercises the SEAM those
 * handlers call once the gate has said yes.
 */
describe.skipIf(!hasTestDb)("candidate disqualification (#723)", () => {
	let seed: SeededClub;
	let secondMemberId: string;

	function open(category: "best_speaker" | "best_table_topics") {
		return openVote({
			meetingId: seed.meetingId,
			category,
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
	}

	beforeEach(async () => {
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				sortOrder: 99,
			})
			.returning({ id: roleDefinitions.id });
		// TWO speakers, so every assertion has an eligible neighbour to compare
		// against: a bug that rules out the whole category looks identical to a
		// correct one when there is only a single candidate.
		const personId = await seedPerson({ name: "Second Speaker" });
		const [m2] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId,
				name: "Second Speaker",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		secondMemberId = m2.id;
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
				assignedMemberId: secondMemberId,
			},
		]);
		await open("best_speaker");
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const rule = (
		candidate: Parameters<typeof disqualifyCandidate>[0]["candidate"],
		reason = "Outside the qualifying window",
		category: "best_speaker" | "best_table_topics" = "best_speaker",
	) =>
		disqualifyCandidate({
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			category,
			candidate,
			reason,
			actorMemberId: seed.adminMemberId,
		});

	const unrule = (
		candidate: Parameters<typeof undoDisqualification>[0]["candidate"],
		category: "best_speaker" | "best_table_topics" = "best_speaker",
	) =>
		undoDisqualification({
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			category,
			candidate,
			actorMemberId: seed.adminMemberId,
		});

	/** Rulings on THIS meeting only. ~50 DB-backed suites share one Postgres, so
	 *  an unscoped select risks asserting on another suite's rows. */
	const myRulings = () =>
		testDb
			.select({
				category: meetingCandidateDisqualifications.category,
				m: meetingCandidateDisqualifications.candidateMemberId,
				g: meetingCandidateDisqualifications.candidateGuestId,
				w: meetingCandidateDisqualifications.candidateWriteIn,
				reason: meetingCandidateDisqualifications.reason,
				by: meetingCandidateDisqualifications.disqualifiedByMemberId,
			})
			.from(meetingCandidateDisqualifications)
			.where(eq(meetingCandidateDisqualifications.meetingId, seed.meetingId));

	/** Vote ROWS for this meeting, scoped through the session join. */
	const myVotes = () =>
		testDb
			.select({ m: meetingVotes.candidateMemberId })
			.from(meetingVotes)
			.innerJoin(
				meetingVoteSessions,
				eq(meetingVoteSessions.id, meetingVotes.sessionId),
			)
			.where(eq(meetingVoteSessions.meetingId, seed.meetingId));

	const voteFor = (voterId: string, candidateId: string) =>
		castVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			voter: { kind: "member", id: voterId },
			candidate: { kind: "member", id: candidateId },
		});

	// AC 3. The one that matters: this calls the server path DIRECTLY, with no
	// UI and no poll, which is exactly the shape a stale phone or a hand-crafted
	// POST has. A ballot that merely hides the button would pass every component
	// test and fail here.
	it("castVote REJECTS a disqualified candidate, called directly", async () => {
		await rule({ kind: "member", id: seed.adminMemberId });
		await expect(voteFor(seed.memberId, seed.adminMemberId)).rejects.toThrow(
			/not eligible/i,
		);
		expect(await myVotes()).toHaveLength(0);
	});

	// The control that makes the assertion above mean something: the rejection
	// has to be about THIS candidate, not about the category having a ruling in
	// it at all.
	it("still accepts the eligible neighbour in the same category", async () => {
		await rule({ kind: "member", id: seed.adminMemberId });
		await expect(
			voteFor(seed.memberId, secondMemberId),
		).resolves.toBeUndefined();
		expect(await myVotes()).toEqual([{ m: secondMemberId }]);
	});

	// The write-in arm skips `isEligibleCandidate` by design (#582), so it needs
	// its own check — without it, the candidate shape the Vote Counter most
	// often has to rule out is the one that cannot be.
	it("castVote REJECTS a disqualified WRITE-IN, folded", async () => {
		await open("best_table_topics");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "writeIn", name: "Bo Smith" },
		});
		await rule(
			{ kind: "writeIn", name: "Bo Smith" },
			"No Word of the Day",
			"best_table_topics",
		);
		// A DIFFERENT spelling of the same name. The column stores the folded key
		// precisely so this is refused: matching raw would let every later voter
		// cast the same person back in by changing their capitals.
		await expect(
			castVote({
				meetingId: seed.meetingId,
				category: "best_table_topics",
				voter: { kind: "member", id: secondMemberId },
				candidate: { kind: "writeIn", name: "  bo   smith " },
			}),
		).rejects.toThrow(/not eligible/i);
	});

	// The read side folds too, and this is the only thing that can prove it.
	//
	// `disqualifyCandidate` folds on the way IN and `castVote` folds the incoming
	// name before looking it up, so for every row this feature writes the fold in
	// `loadDisqualifications` is a no-op — deleting it leaves the whole suite
	// green (verified by mutation). What it defends against is a row written by
	// some path that skips the seam, which is reachable: the column is plain
	// `text` with no normalising constraint, and this is a bulk-editable table
	// like any other. A ruling that fails to MATCH its candidate fails OPEN — the
	// vote goes through — so the defence is worth having and therefore worth
	// pinning. Written raw here, exactly as such a path would.
	it("matches a ruling stored UNFOLDED, so a stray row still bites", async () => {
		await open("best_table_topics");
		await testDb.insert(meetingCandidateDisqualifications).values({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			candidateWriteIn: "  Bo   SMITH ",
			reason: "Written by a path that skipped the seam",
		});
		await expect(
			castVote({
				meetingId: seed.meetingId,
				category: "best_table_topics",
				voter: { kind: "member", id: seed.memberId },
				candidate: { kind: "writeIn", name: "Bo Smith" },
			}),
		).rejects.toThrow(/not eligible/i);
	});

	// The OTHER producer of `AwardCandidate`s. `loadWriteInCandidates` stamps
	// `disqualified` too, and until #723's own review nothing asserted the
	// positive: every write-in case proved only that `castVote` REFUSES one, and
	// that path consults `loadDisqualifications` directly rather than going
	// through this producer. Replacing its stamp with a literal `null` left the
	// whole suite green — on the one category where write-ins are the common
	// case. Verified by mutation.
	it("serves a disqualified WRITE-IN struck through, with its excluded count", async () => {
		await open("best_table_topics");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "writeIn", name: "Bo Smith" },
		});
		await rule(
			{ kind: "writeIn", name: "Bo Smith" },
			"No Word of the Day",
			"best_table_topics",
		);

		const ballot = await loadBallot(seed.meetingId);
		const wi = ballot.categories.best_table_topics.candidates.find(
			(c) => c.kind === "writeIn",
		);
		expect(wi?.disqualified).toEqual({ reason: "No Word of the Day" });

		const tally = await loadTally(seed.meetingId);
		expect(
			tally.best_table_topics.results.some((r) => r.kind === "writeIn"),
		).toBe(false);
		expect(tally.best_table_topics.disqualified).toEqual([
			expect.objectContaining({
				kind: "writeIn",
				id: "bo smith",
				count: 1,
				reason: "No Word of the Day",
			}),
		]);
	});

	// Undo's write-in arm, which had NO coverage and was broken because of it.
	// `loadDisqualifications` re-folds the stored value on read, so a row written
	// unfolded still bites — but the DELETE matched the column exactly, so that
	// same row could never be removed. Combined with the deliberate no-op on zero
	// rows, the Vote Counter tapped Undo, got a resolved promise, and the ruling
	// silently stood. Both halves are asserted here; the second is the one that
	// failed before the fix.
	it("undo removes a WRITE-IN ruling, including one stored unfolded", async () => {
		await open("best_table_topics");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "writeIn", name: "Bo Smith" },
		});
		await rule(
			{ kind: "writeIn", name: "Bo Smith" },
			"No Word of the Day",
			"best_table_topics",
		);
		await unrule({ kind: "writeIn", name: "Bo Smith" }, "best_table_topics");
		expect(await myRulings()).toHaveLength(0);

		// The exact row shape the re-fold test above proves still BITES must also
		// be liftable, or the defence is a trap rather than a defence.
		await testDb.insert(meetingCandidateDisqualifications).values({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			candidateWriteIn: "  Bo   SMITH ",
			reason: "Written by a path that skipped the seam",
		});
		await unrule({ kind: "writeIn", name: "Bo Smith" }, "best_table_topics");
		expect(await myRulings()).toHaveLength(0);
	});

	// The write-in arm's BOUND. Member and guest candidates are bounded by the
	// club roster; a write-in's identity is the free-text string, so without this
	// any distinct string mints a row — plus an `activity_log` row — on a table
	// `loadDisqualifications` reads on the PUBLIC 5s ballot poll.
	it("refuses a write-in ruling for a name nobody cast", async () => {
		await open("best_table_topics");
		await expect(
			rule(
				{ kind: "writeIn", name: "Nobody Voted For Me" },
				"No Word of the Day",
				"best_table_topics",
			),
		).rejects.toThrow(/nobody has voted/i);
		expect(await myRulings()).toHaveLength(0);
	});

	// The bound must not be so tight it rejects the real flow: the console offers
	// the tally's display spelling, and the ballot stores the FIRST spelling
	// cast, so the two can differ in case and spacing from what a later voter
	// typed. Matching folded is what keeps the legitimate ruling working.
	it("accepts a write-in ruling that differs in case and spacing from the cast ballot", async () => {
		await open("best_table_topics");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_table_topics",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "writeIn", name: "Bo Smith" },
		});
		await expect(
			rule(
				{ kind: "writeIn", name: "  bo   SMITH " },
				"No Word of the Day",
				"best_table_topics",
			),
		).resolves.toBeUndefined();
	});

	// AC 6, sharpened. `.rejects.toThrow()` alone would also pass on an
	// app-level pre-check, and the spec says DB-enforced — so this asserts the
	// database is what refuses, by going around the seam entirely with a raw
	// insert and reading the SQLSTATE back.
	it("the unique index — not app code — is what refuses a second ruling", async () => {
		const row = {
			meetingId: seed.meetingId,
			category: "best_speaker" as const,
			candidateMemberId: seed.adminMemberId,
			reason: "First",
		};
		await testDb.insert(meetingCandidateDisqualifications).values(row);
		await expect(
			testDb
				.insert(meetingCandidateDisqualifications)
				.values({ ...row, reason: "Second" }),
		).rejects.toMatchObject({ cause: { code: "23505" } });
	});

	// The other two unique indexes, which the member case above cannot cover.
	// The write-in one matters most: the column is folded on the way in
	// SPECIFICALLY so this index can enforce "not twice", and nothing else
	// proves it does.
	it("the guest and write-in unique indexes refuse a second ruling too", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Visiting Speaker" })
			.returning({ id: guests.id });
		const guestRow = {
			meetingId: seed.meetingId,
			category: "best_speaker" as const,
			candidateGuestId: g.id,
			reason: "First",
		};
		await testDb.insert(meetingCandidateDisqualifications).values(guestRow);
		await expect(
			testDb.insert(meetingCandidateDisqualifications).values(guestRow),
		).rejects.toMatchObject({ cause: { code: "23505" } });

		const writeInRow = {
			meetingId: seed.meetingId,
			category: "best_table_topics" as const,
			candidateWriteIn: "bo smith",
			reason: "First",
		};
		await testDb.insert(meetingCandidateDisqualifications).values(writeInRow);
		await expect(
			testDb.insert(meetingCandidateDisqualifications).values(writeInRow),
		).rejects.toMatchObject({ cause: { code: "23505" } });
	});

	// The exactly-one check. `loadDisqualifications` carries an `if (!key)
	// continue;` whose comment says "unreachable while the table's exactly-one
	// check holds" — a claim resting on a constraint nothing verified. Both
	// directions, because `= 1` fails differently from `<= 1`.
	it("the check constraint refuses a row naming two candidates, or none", async () => {
		await expect(
			testDb.insert(meetingCandidateDisqualifications).values({
				meetingId: seed.meetingId,
				category: "best_speaker",
				candidateMemberId: seed.adminMemberId,
				candidateWriteIn: "bo smith",
				reason: "Two at once",
			}),
		).rejects.toMatchObject({ cause: { code: "23514" } });

		await expect(
			testDb.insert(meetingCandidateDisqualifications).values({
				meetingId: seed.meetingId,
				category: "best_speaker",
				reason: "Nobody at all",
			}),
		).rejects.toMatchObject({ cause: { code: "23514" } });
	});

	// A duplicate ruling reaches the console as a message an officer can act on,
	// not as `duplicate key value violates unique constraint "..."`. The console
	// renders a failed ruling's text verbatim.
	it("reports a duplicate ruling in words, not as a constraint violation", async () => {
		await rule({ kind: "member", id: seed.adminMemberId }, "First reason");
		await expect(
			rule({ kind: "member", id: seed.adminMemberId }, "Second reason"),
		).rejects.toThrow(/already disqualified/i);
	});

	// AC 4. The votes are NOT deleted — that is what makes undo free.
	it("keeps votes cast before the ruling, and drops them from the tally", async () => {
		await voteFor(seed.memberId, seed.adminMemberId);
		await voteFor(secondMemberId, seed.adminMemberId);
		await voteFor(seed.adminMemberId, secondMemberId);

		await rule({ kind: "member", id: seed.adminMemberId });
		const speaker = (await loadTally(seed.meetingId)).best_speaker;

		// Out of the winner list at any count — the ruled-out candidate LEADS 2-1
		// here, which is the case a naive "drop the zero-count rows" would miss.
		expect(speaker.results.map((r) => r.id)).toEqual([secondMemberId]);
		expect(speaker.disqualified).toEqual([
			expect.objectContaining({
				id: seed.adminMemberId,
				count: 2,
				reason: "Outside the qualifying window",
			}),
		]);
		// And the rows themselves are untouched.
		expect(await myVotes()).toHaveLength(3);
	});

	// AC 5. A pure delete, with nothing to reconstruct.
	it("undo restores the candidate to the ballot AND its prior votes to the tally", async () => {
		await voteFor(seed.memberId, seed.adminMemberId);
		await voteFor(secondMemberId, seed.adminMemberId);
		await rule({ kind: "member", id: seed.adminMemberId });
		await unrule({ kind: "member", id: seed.adminMemberId });

		const tally = await loadTally(seed.meetingId);
		expect(tally.best_speaker.disqualified).toEqual([]);
		expect(
			tally.best_speaker.results.find((r) => r.id === seed.adminMemberId)
				?.count,
		).toBe(2);

		const ballot = await loadBallot(seed.meetingId);
		expect(
			ballot.categories.best_speaker.candidates.map((c) => c.disqualified),
		).toEqual([null, null]);
		// And the vote the gate refused while the ruling stood now lands.
		await expect(
			voteFor(seed.adminMemberId, seed.adminMemberId),
		).resolves.toBeUndefined();
	});

	it("undoing a ruling that is not there is a no-op, not an error", async () => {
		await expect(
			unrule({ kind: "member", id: seed.adminMemberId }),
		).resolves.toBeUndefined();
		expect(await myRulings()).toHaveLength(0);
	});

	// AC 6, DB-enforced. Two officers can have this console open at once; the
	// second one to tap must learn the ruling exists rather than silently
	// replace the first one's stated reason.
	it("a second ruling on the same candidate in the same category is refused", async () => {
		await rule({ kind: "member", id: seed.adminMemberId }, "First reason");
		await expect(
			rule({ kind: "member", id: seed.adminMemberId }, "Second reason"),
		).rejects.toThrow();
		expect(await myRulings()).toEqual([
			expect.objectContaining({ reason: "First reason" }),
		]);
	});

	// AC 7. The same person, two awards, one ruling.
	it("a ruling in one category does not touch the same person in another", async () => {
		await open("best_table_topics");
		await testDb.insert(tableTopicsSpeakers).values({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
			sortOrder: 0,
		});
		await rule({ kind: "member", id: seed.adminMemberId });

		const ballot = await loadBallot(seed.meetingId);
		const inSpeaker = ballot.categories.best_speaker.candidates.find(
			(c) => c.id === seed.adminMemberId,
		);
		const inTopics = ballot.categories.best_table_topics.candidates.find(
			(c) => c.id === seed.adminMemberId,
		);
		expect(inSpeaker?.disqualified).toEqual({
			reason: "Outside the qualifying window",
		});
		expect(inTopics?.disqualified).toBe(null);
		// And the gate agrees with the ballot — the two must never drift.
		await expect(
			castVote({
				meetingId: seed.meetingId,
				category: "best_table_topics",
				voter: { kind: "member", id: seed.memberId },
				candidate: { kind: "member", id: seed.adminMemberId },
			}),
		).resolves.toBeUndefined();
	});

	// AC 2, server half: the ballot SERVES the ruled-out candidate rather than
	// dropping them, and carries the reason. A name vanishing from a voter's
	// screen mid-meeting reads as a bug.
	it("the ballot keeps the ruled-out candidate, with the reason", async () => {
		await rule(
			{ kind: "member", id: seed.adminMemberId },
			"No Word of the Day",
		);
		const list = (await loadBallot(seed.meetingId)).categories.best_speaker
			.candidates;
		expect(list).toHaveLength(2);
		expect(list.find((c) => c.id === seed.adminMemberId)?.disqualified).toEqual(
			{ reason: "No Word of the Day" },
		);
	});

	// AC 9. The reason is in the log as well as in the row, because the row is
	// deleted on undo and a club asking "why was she ruled out and then not" has
	// nowhere else to look.
	it("both writes reach activity_log", async () => {
		await rule(
			{ kind: "member", id: seed.adminMemberId },
			"No Word of the Day",
		);
		await unrule({ kind: "member", id: seed.adminMemberId });
		const rows = await testDb
			.select({
				action: activityLog.action,
				actor: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(eq(activityLog.clubId, seed.clubId));
		const mine = rows.filter((r) => r.action.startsWith("vote_disqualify"));
		expect(mine.map((r) => r.action).sort()).toEqual([
			"vote_disqualify",
			"vote_disqualify_undo",
		]);
		expect(mine.every((r) => r.actor === seed.adminMemberId)).toBe(true);
		expect(mine.find((r) => r.action === "vote_disqualify")?.detail).toEqual({
			category: "best_speaker",
			reason: "No Word of the Day",
		});
	});

	// AC 10. `on delete cascade`, which is the whole reason this table can carry
	// an exactly-one check where `meeting_votes` cannot.
	it("deleting the member takes their ruling with it", async () => {
		await rule({ kind: "member", id: secondMemberId });
		expect(await myRulings()).toHaveLength(1);
		await testDb.delete(members).where(eq(members.id, secondMemberId));
		expect(await myRulings()).toHaveLength(0);
	});

	it("deleting a guest takes their ruling with it", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Visiting Speaker" })
			.returning({ id: guests.id });
		await rule({ kind: "guest", id: g.id });
		expect(await myRulings()).toHaveLength(1);
		await testDb.delete(guests).where(eq(guests.id, g.id));
		expect(await myRulings()).toHaveLength(0);
	});

	it("refuses a blank reason — the column is NOT NULL for a reason", async () => {
		await expect(
			rule({ kind: "member", id: seed.adminMemberId }, "   "),
		).rejects.toThrow(/reason/i);
		expect(await myRulings()).toHaveLength(0);
	});

	it("refuses a reason past the cap rather than storing a truncated one", async () => {
		await expect(
			rule({ kind: "member", id: seed.adminMemberId }, "x".repeat(5000)),
		).rejects.toThrow(/too long/i);
		expect(await myRulings()).toHaveLength(0);
	});

	// The candidate FKs reference `members`/`guests` globally, so without the
	// club scope an officer of one club could mint rows naming another club's
	// people. They would match no candidate and rule out nobody — but a write
	// that crosses a club boundary at all is the wrong shape for a table about
	// one person excluding another.
	it("refuses a candidate belonging to another club", async () => {
		const other = await seedClub();
		try {
			await expect(
				rule({ kind: "member", id: other.memberId }),
			).rejects.toThrow(/not found/i);
			expect(await myRulings()).toHaveLength(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	// AC 11. The club that never disqualifies anyone must see nothing new — and
	// "nothing new" is a claim about the payloads, not about the screen.
	it("a meeting with no rulings carries null on every candidate and an empty list", async () => {
		await voteFor(seed.memberId, seed.adminMemberId);
		const ballot = await loadBallot(seed.meetingId);
		expect(
			ballot.categories.best_speaker.candidates.every(
				(c) => c.disqualified === null,
			),
		).toBe(true);
		const tally = await loadTally(seed.meetingId);
		for (const category of [
			"best_speaker",
			"best_evaluator",
			"best_table_topics",
		] as const) {
			expect(tally[category].disqualified).toEqual([]);
		}
		expect(tally.best_speaker.results).toHaveLength(2);
	});
});

describe.skipIf(!hasTestDb)("digital voting switched off (#770)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
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
			roleDefinitionId: def.id,
			slotIndex: 0,
			assignedMemberId: seed.adminMemberId,
		});
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/** Flip a switch straight in the database — WITHOUT closing anything — so
	 *  each gate is shown to hold on its own, not because a force-close already
	 *  ran. The force-close is `meeting-digital-voting.integration.test.ts`. */
	const switchOff = {
		club: () =>
			testDb
				.update(clubs)
				.set({ digitalVotingEnabled: false })
				.where(eq(clubs.id, seed.clubId)),
		meeting: () =>
			testDb
				.update(meetings)
				.set({ digitalVotingDisabled: true })
				.where(eq(meetings.id, seed.meetingId)),
	};

	const open = () =>
		openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});

	const sessionsForMeeting = () =>
		testDb
			.select({ id: meetingVoteSessions.id })
			.from(meetingVoteSessions)
			.where(eq(meetingVoteSessions.meetingId, seed.meetingId));

	for (const which of ["club", "meeting"] as const) {
		describe(`off by the ${which} switch`, () => {
			it("openVote refuses and opens nothing", async () => {
				await switchOff[which]();
				await expect(open()).rejects.toThrow(
					"Digital voting is off for this meeting.",
				);
				expect(await sessionsForMeeting()).toHaveLength(0);
			});

			it("castVote refuses a ballot into a session that is still open", async () => {
				await open();
				await switchOff[which]();
				await expect(
					castVote({
						meetingId: seed.meetingId,
						category: "best_speaker",
						voter: { kind: "member", id: seed.memberId },
						candidate: { kind: "member", id: seed.adminMemberId },
					}),
				).rejects.toThrow("Digital voting is off for this meeting.");
				const [session] = await sessionsForMeeting();
				const votes = await testDb
					.select({ id: meetingVotes.id })
					.from(meetingVotes)
					.where(eq(meetingVotes.sessionId, session.id));
				expect(votes).toHaveLength(0);
			});

			it("joinBallotAsGuest refuses and mints no guest", async () => {
				await switchOff[which]();
				await expect(
					joinBallotAsGuest({ meetingId: seed.meetingId, name: "Osei, Kwame" }),
				).rejects.toThrow("Digital voting is off for this meeting.");
				expect(
					await testDb
						.select({ id: guests.id })
						.from(guests)
						.where(eq(guests.clubId, seed.clubId)),
				).toHaveLength(0);
				expect(
					await testDb
						.select({ guestId: meetingBallotGuests.guestId })
						.from(meetingBallotGuests)
						.where(eq(meetingBallotGuests.meetingId, seed.meetingId)),
				).toHaveLength(0);
			});

			it("loadBallot says so and ships no candidates, even with a session open", async () => {
				await open();
				await switchOff[which]();
				const ballot = await loadBallot(seed.meetingId);
				expect(ballot.digitalVotingOff).toBe(true);
				for (const c of Object.values(ballot.categories)) {
					expect(c.isOpen).toBe(false);
					expect(c.candidates).toEqual([]);
				}
			});

			it("loadParticipation reports no ballots, even with one cast", async () => {
				await open();
				await castVote({
					meetingId: seed.meetingId,
					category: "best_speaker",
					voter: { kind: "member", id: seed.memberId },
					candidate: { kind: "member", id: seed.adminMemberId },
				});
				await switchOff[which]();
				const p = await loadParticipation(seed.meetingId);
				expect(p.categories.best_speaker.ballotsIn).toBe(0);
				expect(p.presentCount).toBeNull();
			});
		});
	}

	it("still lets the Ballot Counter close a vote and read its tally once off", async () => {
		await open();
		await castVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "member", id: seed.adminMemberId },
		});
		await switchOff.meeting();
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		const tally = await loadTally(seed.meetingId);
		expect(JSON.stringify(tally)).toContain(seed.adminMemberId);
	});

	it("loadBallot reports digitalVotingOff false while it is on", async () => {
		expect((await loadBallot(seed.meetingId)).digitalVotingOff).toBe(false);
	});
});

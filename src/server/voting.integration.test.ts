/**
 * DB-backed integration tests for digital voting (#510).
 *
 * The constraints in this file are the feature's real safety net: one vote per
 * person per category is enforced by a unique index, not by application code,
 * and the member-XOR-guest shape by check constraints. Exercised against a live
 * Postgres identified by TEST_DATABASE_URL; the whole suite skips when unset.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAttendance,
	meetingBallotGuests,
	meetings,
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
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	castVote,
	closeVote,
	joinBallotAsGuest,
	listVoteSessions,
	loadBallot,
	loadParticipation,
	loadTally,
	openVote,
} = await import("#/server/voting-logic");
const { applyCompleteMeeting } = await import("#/server/meetings-logic");
const { setAward } = await import("#/server/minutes-logic");
const { assertMeetingNotLocked } = await import("#/server/meeting-authz-logic");

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
		await castVote(ballot({ voter: { kind: "guest", id: g.id } }));
		const rows = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(rows[0].voterGuestId).toBe(g.id);
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
		// The lock assert lives in the server fn, not in `openVote`, so assert it
		// where it actually is.
		expect(() => assertMeetingNotLocked("completed")).toThrow();
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

		it("reusing an existing guest does not consume cap headroom", async () => {
			for (let i = 0; i < 60; i++) {
				await joinBallotAsGuest({
					meetingId: seed.meetingId,
					name: `Visitor ${i}`,
				});
			}
			// The cap is full. Re-identifying as someone already on the ballot must
			// still succeed — reuse is not gated by the cap.
			await expect(
				joinBallotAsGuest({ meetingId: seed.meetingId, name: "Visitor 0" }),
			).resolves.toMatchObject({ name: "Visitor 0" });
			// A genuinely new name is still refused.
			await expect(
				joinBallotAsGuest({ meetingId: seed.meetingId, name: "One too many" }),
			).rejects.toThrow(/too many/i);
		});
	});
});

/**
 * DB-backed integration tests for digital voting (#510).
 *
 * The constraints in this file are the feature's real safety net: one vote per
 * person per category is enforced by a unique index, not by application code,
 * and the member-XOR-guest shape by check constraints. Exercised against a live
 * Postgres identified by TEST_DATABASE_URL; the whole suite skips when unset.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAttendance,
	meetingVoteSessions,
	meetingVotes,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	castVote,
	closeVote,
	listVoteSessions,
	loadBallot,
	loadParticipation,
	loadTally,
	openVote,
} = await import("#/server/voting-logic");

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
		const rows = await testDb.select().from(meetingVotes);
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
		const rows = await testDb.select().from(meetingVotes);
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
		expect(await testDb.select().from(meetingVotes)).toHaveLength(0);
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
			expect(await testDb.select().from(meetingVotes)).toHaveLength(0);
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
		const rows = await testDb.select().from(meetingVotes);
		expect(rows[0].voterGuestId).toBe(g.id);
	});

	it("allows a self-vote — deliberately not blocked", async () => {
		await castVote(
			ballot({ voter: { kind: "member", id: seed.adminMemberId } }),
		);
		expect(await testDb.select().from(meetingVotes)).toHaveLength(1);
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

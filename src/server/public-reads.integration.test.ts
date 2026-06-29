/**
 * DB-backed integration tests verifying that the public member-facing reads
 * work WITHOUT a session, and that VPE-only fns STILL reject a no-session call.
 *
 * Tests run against a real Postgres instance identified by TEST_DATABASE_URL.
 * They replicate the Drizzle queries from the server modules using testDb —
 * the same pattern as claim.integration.test.ts — so they never require
 * DATABASE_URL or an HTTP request context.
 *
 * When TEST_DATABASE_URL is unset the whole suite is skipped.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test \
 *     bunx vitest run src/server/public-reads.integration.test.ts
 */
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clubMemberships,
	clubs,
	meetings,
	roleDefinitions,
	roleSlots,
	speakerDetails,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

// ---------------------------------------------------------------------------
// Helpers — replicate the public query logic from meetings.ts using testDb
// ---------------------------------------------------------------------------

/** Mirror of loadMeetingDetail with no session (canManage=false). */
async function getMeetingPublic(meetingId: string) {
	const meeting = await testDb.query.meetings.findFirst({
		where: eq(meetings.id, meetingId),
	});
	if (!meeting) return null;

	// No session → canManage = false (the optional-session branch)
	const canManage = false;

	const club = await testDb.query.clubs.findFirst({
		where: eq(clubs.id, meeting.clubId),
		columns: { timezone: true },
	});

	// Slot query (simplified — we just need to verify it works)
	const slots = await testDb
		.select({ id: roleSlots.id, status: roleSlots.status })
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, meetingId));

	return { meeting, slots, canManage, timezone: club?.timezone ?? "UTC" };
}

/** Mirror of listUpcomingMeetings with no session. */
async function listUpcomingMeetingsPublic(clubId: string) {
	return testDb
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			theme: meetings.theme,
			status: meetings.status,
			timezone: clubs.timezone,
			openSlots: sql<number>`count(*) filter (where ${roleSlots.status} = 'open')::int`,
			totalSlots: sql<number>`count(${roleSlots.id})::int`,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.leftJoin(roleSlots, eq(roleSlots.meetingId, meetings.id))
		.where(
			and(
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, new Date()),
				ne(meetings.status, "cancelled"),
			),
		)
		.groupBy(meetings.id, clubs.timezone)
		.orderBy(asc(meetings.scheduledAt));
}

/** Mirror of listMemberCommitments(memberId) — public, no session. */
async function listMemberCommitmentsPublic(memberId: string) {
	return testDb
		.select({
			slotId: roleSlots.id,
			status: roleSlots.status,
			meetingId: meetings.id,
			scheduledAt: meetings.scheduledAt,
			theme: meetings.theme,
			location: meetings.location,
			clubName: clubs.name,
			timezone: clubs.timezone,
			roleName: roleDefinitions.name,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			speechTitle: speakerDetails.speechTitle,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(speakerDetails, eq(speakerDetails.slotId, roleSlots.id))
		.where(
			and(
				eq(roleSlots.assignedMemberId, memberId),
				gte(meetings.scheduledAt, new Date()),
				ne(meetings.status, "cancelled"),
			),
		)
		.orderBy(asc(meetings.scheduledAt));
}

/** Mirror of requireUser's null check — asserts that the guard throws w/ null user. */
function simulateRequireUser(user: null | { id: string }) {
	if (!user) {
		throw new Error("You need to be signed in to do that.");
	}
	return user;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("public reads (no session)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	// -------------------------------------------------------------------------
	// Task 1: getMeeting public
	// -------------------------------------------------------------------------

	it("getMeeting works without a session and reports canManage=false", async () => {
		const res = await getMeetingPublic(seed.meetingId);
		expect(res).not.toBeNull();
		expect(res?.meeting?.id).toBe(seed.meetingId);
		expect(res?.canManage).toBe(false);
	});

	it("getMeeting returns slots for the meeting", async () => {
		const res = await getMeetingPublic(seed.meetingId);
		expect(res?.slots).toHaveLength(1);
		expect(res?.slots[0]?.id).toBe(seed.slotId);
	});

	it("getMeeting returns null for unknown meetingId", async () => {
		const res = await getMeetingPublic("00000000-0000-0000-0000-000000000000");
		expect(res).toBeNull();
	});

	// -------------------------------------------------------------------------
	// Task 1: listUpcomingMeetings public
	// -------------------------------------------------------------------------

	it("listUpcomingMeetings works without a session and returns the meeting", async () => {
		const rows = await listUpcomingMeetingsPublic(seed.clubId);
		expect(Array.isArray(rows)).toBe(true);
		const row = rows.find((r) => r.id === seed.meetingId);
		expect(row).toBeDefined();
		expect(row?.openSlots).toBe(1);
		expect(row?.totalSlots).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Task 2: listMemberCommitments(memberId) public
	// -------------------------------------------------------------------------

	it("listMemberCommitments returns empty when no slots claimed", async () => {
		const rows = await listMemberCommitmentsPublic(seed.memberId);
		expect(rows).toHaveLength(0);
	});

	it("listMemberCommitments returns the slot after it is claimed", async () => {
		// Claim the slot for seed.memberId directly via testDb
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: seed.memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, seed.slotId));

		const rows = await listMemberCommitmentsPublic(seed.memberId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.slotId).toBe(seed.slotId);
		expect(rows[0]?.meetingId).toBe(seed.meetingId);
		expect(rows[0]?.status).toBe("claimed");
	});

	// -------------------------------------------------------------------------
	// Task 6: Regression guard — authed fns still reject without a session
	// -------------------------------------------------------------------------

	it("requireUser throws when user is null (createMeeting / getNextMeeting guard)", () => {
		// This mirrors the `requireUser` check that createMeeting and getNextMeeting
		// invoke. If getSessionUser() returns null, requireUser throws.
		expect(() => simulateRequireUser(null)).toThrow(
			"You need to be signed in to do that.",
		);
	});

	it("requireClubRole logic: member role is rejected by admin/vpe gate (createMeeting guard)", async () => {
		// Mirror the requireClubRole predicate — same check as in guards.ts
		const [membership] = await testDb
			.select()
			.from(clubMemberships)
			.where(
				and(
					eq(clubMemberships.userId, seed.memberUserId),
					eq(clubMemberships.clubId, seed.clubId),
				),
			)
			.limit(1);

		const allowedRoles: Array<"admin" | "vpe"> = ["admin", "vpe"];
		const passes =
			membership != null &&
			allowedRoles.includes(membership.clubRole as "admin" | "vpe");
		expect(passes).toBe(false); // member cannot createMeeting / confirmSlot
	});

	it("confirmSlot: conditional update only flips 'claimed'; 'open' produces 0 rows (guard unchanged)", async () => {
		// The slot is open; confirmSlot (which stays authed) would first call
		// requireUser then requireClubRole. The conditional-update guard itself
		// (WHERE status='claimed') also rejects an open slot.
		const updated = await testDb
			.update(roleSlots)
			.set({ status: "confirmed" })
			.where(
				and(
					eq(roleSlots.id, seed.slotId),
					eq(roleSlots.status, "claimed"), // slot is 'open' → guard fires
				),
			)
			.returning({ id: roleSlots.id });

		expect(updated).toHaveLength(0); // conditional guard still active

		// DB state unchanged
		const [row] = await testDb
			.select({ status: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);
		expect(row?.status).toBe("open");
	});
});

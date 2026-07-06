/**
 * DB-backed tests for the per-meeting agenda-write authorization (ADR-0010):
 * a club admin OR the meeting's self-asserted TMOD may edit; reschedule stays
 * admin-only. Tests the plain logic fns directly (`#/db` → test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-authz.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, roleDefinitions, roleSlots } from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveMeetingAgendaAuthz } = await import("./meeting-authz-logic");
const { applyMeetingUpdate } = await import("./meetings-logic");

/** Add a Toastmaster of the Day role def + slot to the meeting; optionally
 *  assign a roster member. Returns the slot id. */
async function addTmodSlot(
	club: SeededClub,
	assignedMemberId: string | null,
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: "Toastmaster of the Day",
			category: "leadership",
			isSpeakerRole: false,
			sortOrder: 1,
		})
		.returning({ id: roleDefinitions.id });
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: club.meetingId,
			roleDefinitionId: def.id,
			status: assignedMemberId ? "claimed" : "open",
			assignedMemberId,
		})
		.returning({ id: roleSlots.id });
	return slot.id;
}

/** Insert an extra active roster member; return its id. Every membership needs
 *  a Person (ADR-0008 / #64) — seed one first. */
async function addRosterMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	return m.id;
}

describe.skipIf(!hasTestDb)("meeting agenda authorization", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("allows a club admin (session) — via admin", async () => {
		await addTmodSlot(club, null);
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.adminUserId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
	});

	it("allows a member promoted to admin (session) — via admin", async () => {
		// Promote the member's membership row to admin (resolved via their Person).
		await testDb
			.update(members)
			.set({ clubRole: "admin" })
			.where(eq(members.id, club.memberId));
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.memberUserId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
	});

	it("allows the meeting's TMOD self-assert — via tmod-self-assert", async () => {
		await addTmodSlot(club, club.memberId);
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("tmod-self-assert");
		expect(authz.tmodMemberId).toBe(club.memberId);
	});

	it("rejects a non-TMOD, non-admin roster member", async () => {
		await addTmodSlot(club, club.memberId);
		const other = await addRosterMember(club.clubId, "Someone Else");
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: other,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.via).toBe(null);
	});

	it("rejects self-assert when the TMOD slot is unassigned", async () => {
		await addTmodSlot(club, null);
		const someone = await addRosterMember(club.clubId, "Wannabe");
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId: someone,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.tmodMemberId).toBe(null);
	});

	it("rejects a plain member session with no self-assert", async () => {
		await addTmodSlot(club, club.memberId);
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.memberUserId,
		});
		expect(authz.allowed).toBe(false);
	});

	it("meta edit is allowed for a TMOD (canReschedule=false) when time is unchanged", async () => {
		// Re-submit the current wall time so it round-trips to the same instant.
		const current = await testDb.query.meetings.findFirst({
			where: (m, { eq: e }) => e(m.id, club.meetingId),
		});
		expect(current).toBeTruthy();
		// seedClub uses the default club timezone (America/Chicago); convert the
		// stored UTC instant back to its wall-clock string so it round-trips.
		const wall = current
			? utcToZonedWallTime(current.scheduledAt, "America/Chicago")
			: "";
		await expect(
			applyMeetingUpdate({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				scheduledAt: wall,
				theme: "TMOD picked this",
				canReschedule: false,
			}),
		).resolves.toBeTruthy();
	});

	it("rejects a TMOD reschedule (date/time change, canReschedule=false)", async () => {
		await expect(
			applyMeetingUpdate({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				scheduledAt: "2099-01-01T12:00",
				canReschedule: false,
			}),
		).rejects.toThrow(/reschedule/i);
	});

	it("rejects a TMOD length change (canReschedule=false)", async () => {
		const current = await testDb.query.meetings.findFirst({
			where: (m, { eq: e }) => e(m.id, club.meetingId),
		});
		const wall = current
			? utcToZonedWallTime(current.scheduledAt, "America/Chicago")
			: "";
		await expect(
			applyMeetingUpdate({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
				scheduledAt: wall,
				lengthMinutes: (current?.lengthMinutes ?? 90) + 15,
				canReschedule: false,
			}),
		).rejects.toThrow(/reschedule/i);
	});
});

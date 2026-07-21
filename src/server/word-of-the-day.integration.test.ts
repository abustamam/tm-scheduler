/**
 * DB-backed tests for the narrow Word-of-the-Day edit capability (#296): a club
 * admin, the meeting's self-asserted TMOD, OR the meeting's self-asserted
 * Grammarian may edit the three WOD fields — and nothing else. Tests the plain
 * logic fns directly (`#/db` → test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/word-of-the-day.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings, members, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveWordOfTheDayAuthz } = await import("./meeting-authz-logic");
const { applyWordOfTheDayUpdate } = await import("./meetings-logic");

/** Add a named role def + slot to the meeting; optionally assign a member.
 *  Returns the slot id. */
async function addRoleSlot(
	club: SeededClub,
	name: string,
	assignedMemberId: string | null,
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name,
			category: "functionary",
			isSpeakerRole: false,
			sortOrder: 50,
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

/** Insert an extra active roster member; return its id. */
async function addRosterMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	return m.id;
}

describe.skipIf(!hasTestDb)("resolveWordOfTheDayAuthz", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("allows a club admin (session) — via admin", async () => {
		const authz = await resolveWordOfTheDayAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.adminUserId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
	});

	it("allows the meeting's TMOD self-assert — via tmod-self-assert", async () => {
		await addRoleSlot(club, "Toastmaster of the Day", club.memberId);
		const authz = await resolveWordOfTheDayAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("tmod-self-assert");
	});

	it("allows the meeting's Grammarian self-assert — via grammarian-self-assert", async () => {
		await addRoleSlot(club, "Grammarian", club.memberId);
		const authz = await resolveWordOfTheDayAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("grammarian-self-assert");
		expect(authz.grammarianMemberId).toBe(club.memberId);
	});

	it("rejects a roster member who holds neither the TMOD nor Grammarian slot", async () => {
		await addRoleSlot(club, "Grammarian", club.memberId);
		const other = await addRosterMember(club.clubId, "Someone Else");
		const authz = await resolveWordOfTheDayAuthz({
			meetingId: club.meetingId,
			selfMemberId: other,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.via).toBe(null);
	});

	it("rejects Grammarian self-assert when the Grammarian slot is unassigned", async () => {
		await addRoleSlot(club, "Grammarian", null);
		const someone = await addRosterMember(club.clubId, "Wannabe");
		const authz = await resolveWordOfTheDayAuthz({
			meetingId: club.meetingId,
			selfMemberId: someone,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.grammarianMemberId).toBe(null);
	});

	it("throws when the meeting is completed (locked choke point)", async () => {
		await addRoleSlot(club, "Grammarian", club.memberId);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
		await expect(
			resolveWordOfTheDayAuthz({
				meetingId: club.meetingId,
				selfMemberId: club.memberId,
			}),
		).rejects.toThrow();
	});
});

describe.skipIf(!hasTestDb)("applyWordOfTheDayUpdate", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("writes only the three WOD fields, leaving theme/location/scheduledAt untouched", async () => {
		const before = await testDb.query.meetings.findFirst({
			where: eq(meetings.id, club.meetingId),
		});
		// Give the meeting some existing meta the WOD write must NOT disturb.
		await testDb
			.update(meetings)
			.set({ theme: "Existing theme", location: "Room 5" })
			.where(eq(meetings.id, club.meetingId));

		await applyWordOfTheDayUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			wordOfTheDay: "ineffable",
			wodDefinition: "too great to be expressed in words",
			wodExample: "an ineffable joy",
		});

		const after = await testDb.query.meetings.findFirst({
			where: eq(meetings.id, club.meetingId),
		});
		expect(after?.wordOfTheDay).toBe("ineffable");
		expect(after?.wodDefinition).toBe("too great to be expressed in words");
		expect(after?.wodExample).toBe("an ineffable joy");
		// Untouched:
		expect(after?.theme).toBe("Existing theme");
		expect(after?.location).toBe("Room 5");
		expect(after?.scheduledAt.getTime()).toBe(before?.scheduledAt.getTime());
		expect(after?.status).toBe("scheduled");
	});

	it("trims and nulls empty WOD values", async () => {
		await applyWordOfTheDayUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			wordOfTheDay: "  loquacious  ",
			wodDefinition: "   ",
			wodExample: undefined,
		});
		const after = await testDb.query.meetings.findFirst({
			where: eq(meetings.id, club.meetingId),
		});
		expect(after?.wordOfTheDay).toBe("loquacious");
		expect(after?.wodDefinition).toBe(null);
		expect(after?.wodExample).toBe(null);
	});
});

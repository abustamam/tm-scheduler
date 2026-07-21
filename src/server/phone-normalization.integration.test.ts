/**
 * DB-backed tests for normalize-on-write phone standardization (#295): every
 * server write path that stores a phone number coalesces it to E.164 with the
 * club's default country code, so stored data is standardized (not just
 * coalesced at read time). Tests the plain logic fns directly (`#/db` → test DB).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/phone-normalization.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, guests, members, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMemberEdit, applyBulkImport } = await import("./members-logic");
const { applyAssignGuestToSlot } = await import("./guests-logic");
const { applyConvertGuestToMember } = await import("./guest-pipeline-logic");
const { importPeopleAndMembers } = await import("./import-members-logic");

/** Set the seeded club's default international dialing code. */
async function setClubCountryCode(clubId: string, cc: string | null) {
	await testDb
		.update(clubs)
		.set({ defaultCountryCode: cc })
		.where(eq(clubs.id, clubId));
}

describe.skipIf(!hasTestDb)("phone normalize-on-write (#295)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
		await setClubCountryCode(club.clubId, "+1");
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("member edit stores E.164 using the club default country code", async () => {
		await applyMemberEdit({
			clubId: club.clubId,
			memberId: club.memberId,
			name: "Member User",
			phone: "415-555-2671",
		});
		const [m] = await testDb
			.select({ phone: members.phone })
			.from(members)
			.where(eq(members.id, club.memberId));
		expect(m.phone).toBe("+14155552671");
	});

	it("member edit keeps an already-international number, stripping formatting", async () => {
		await applyMemberEdit({
			clubId: club.clubId,
			memberId: club.memberId,
			name: "Member User",
			phone: "+44 20 7946 0958",
		});
		const [m] = await testDb
			.select({ phone: members.phone })
			.from(members)
			.where(eq(members.id, club.memberId));
		expect(m.phone).toBe("+442079460958");
	});

	it("bulk import stores E.164 on both the person and the membership", async () => {
		await applyBulkImport({
			clubId: club.clubId,
			rows: [
				{ name: "Bulk Person", email: "", phone: "(415) 555-2671", office: "" },
			],
		});
		const [p] = await testDb
			.select({ phone: people.phone })
			.from(people)
			.where(eq(people.name, "Bulk Person"));
		const [m] = await testDb
			.select({ phone: members.phone })
			.from(members)
			.where(eq(members.name, "Bulk Person"));
		expect(p.phone).toBe("+14155552671");
		expect(m.phone).toBe("+14155552671");
	});

	it("assigning a new guest to a slot stores the guest phone as E.164", async () => {
		await applyAssignGuestToSlot({
			slotId: club.slotId,
			newGuest: { name: "Guest One", phone: "415.555.2671" },
			actorMemberId: null,
		});
		const [g] = await testDb
			.select({ phone: guests.phone })
			.from(guests)
			.where(eq(guests.clubId, club.clubId));
		expect(g.phone).toBe("+14155552671");
	});

	it("converting a guest to a member carries the phone across as E.164", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({
				clubId: club.clubId,
				name: "Convert Guest",
				phone: "415-555-2671",
				stage: "prospect",
			})
			.returning({ id: guests.id });
		await applyConvertGuestToMember({
			clubId: club.clubId,
			guestId: g.id,
			actorMemberId: null,
		});
		const [p] = await testDb
			.select({ phone: people.phone })
			.from(people)
			.where(eq(people.name, "Convert Guest"));
		const [m] = await testDb
			.select({ phone: members.phone })
			.from(members)
			.where(eq(members.name, "Convert Guest"));
		expect(p.phone).toBe("+14155552671");
		expect(m.phone).toBe("+14155552671");
	});

	it("CSV import stores E.164 on the person and membership", async () => {
		await importPeopleAndMembers(club.clubId, [
			{
				customerId: null,
				name: "Csv Person",
				email: null,
				phone: "415-555-2671",
				joinedAt: null,
				originalJoinDate: null,
				officerPosition: null,
				currentPosition: null,
			},
		]);
		const [p] = await testDb
			.select({ phone: people.phone })
			.from(people)
			.where(eq(people.name, "Csv Person"));
		const [m] = await testDb
			.select({ phone: members.phone })
			.from(members)
			.where(eq(members.name, "Csv Person"));
		expect(p.phone).toBe("+14155552671");
		expect(m.phone).toBe("+14155552671");
	});

	it("preserves a bare national number when the club has no default country code", async () => {
		await setClubCountryCode(club.clubId, null);
		await applyMemberEdit({
			clubId: club.clubId,
			memberId: club.memberId,
			name: "Member User",
			phone: "415-555-2671",
		});
		const [m] = await testDb
			.select({ phone: members.phone })
			.from(members)
			.where(eq(members.id, club.memberId));
		// Can't be made reliable, but must not be dropped.
		expect(m.phone).toBe("415-555-2671");
	});
});

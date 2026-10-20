/**
 * DB-backed tests for #1213: undoing a guest conversion deletes the membership
 * the conversion created, and the member's attendance, Table Topics turns and
 * awards (ON DELETE SET NULL) would be left nameless on the meeting's agenda and
 * minutes. `applyUndoGuestConversion` refuses instead, on the created path only.
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the suite skips when unset.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubActionItems,
	guests,
	meetingAttendance,
	meetingAwards,
	members,
	people,
	tableTopicsSpeakers,
} from "#/db/schema";
import { UNDO_MEMBER_HAS_HISTORY_MESSAGE } from "#/lib/guest-convert";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyConvertGuestToMember, applyUndoGuestConversion } = await import(
	"#/server/guest-pipeline-logic"
);

describe.skipIf(!hasTestDb)(
	"undo guest conversion: name-blanking history (#1213)",
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

		async function seedGuest(name: string) {
			const [g] = await testDb
				.insert(guests)
				.values(await withGuestPerson({ clubId: seed.clubId, name }, testDb))
				.returning({ id: guests.id });
			if (!g) throw new Error("Failed to seed guest");
			return g.id;
		}

		async function converted(name: string) {
			const guestId = await seedGuest(name);
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			strayPeople.push(res.personId);
			return { guestId, ...res };
		}

		function undo(guestId: string) {
			return applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
		}

		async function expectMembershipSurvives(membershipId: string) {
			const [m] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, membershipId));
			expect(m?.id).toBe(membershipId);
		}

		// protects=a created membership with an attendance row (any status) is not
		// deleted, so the row keeps its name; fails_when=the attendance check is
		// dropped from the undo's checks; no_claim=the reuse path (below)
		it.each([
			"present",
			"absent",
		] as const)("refuses when the member has a %s attendance row, and keeps it", async (status) => {
			const { guestId, membershipId } = await converted(`Attended ${status}`);
			const [row] = await testDb
				.insert(meetingAttendance)
				.values({ meetingId: seed.meetingId, memberId: membershipId, status })
				.returning({ id: meetingAttendance.id });
			if (!row) throw new Error("Failed to seed attendance");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("meeting attendance"),
			);
			await expectMembershipSurvives(membershipId);
			const [left] = await testDb
				.select({ memberId: meetingAttendance.memberId })
				.from(meetingAttendance)
				.where(eq(meetingAttendance.id, row.id));
			expect(left?.memberId).toBe(membershipId);
		});

		// fails_when=the Table Topics check is dropped from the undo's checks
		it("refuses when the member has a Table Topics turn, and keeps it", async () => {
			const { guestId, membershipId } = await converted("Topics Speaker");
			const [row] = await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: seed.meetingId, memberId: membershipId })
				.returning({ id: tableTopicsSpeakers.id });
			if (!row) throw new Error("Failed to seed Table Topics turn");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("Table Topics turns"),
			);
			await expectMembershipSurvives(membershipId);
			const [left] = await testDb
				.select({ memberId: tableTopicsSpeakers.memberId })
				.from(tableTopicsSpeakers)
				.where(eq(tableTopicsSpeakers.id, row.id));
			expect(left?.memberId).toBe(membershipId);
		});

		// fails_when=the awards check is dropped from the undo's checks
		it("refuses when the member won an award, and keeps it", async () => {
			const { guestId, membershipId } = await converted("Award Winner");
			const [row] = await testDb
				.insert(meetingAwards)
				.values({
					meetingId: seed.meetingId,
					category: "best_speaker",
					memberId: membershipId,
				})
				.returning({ id: meetingAwards.id });
			if (!row) throw new Error("Failed to seed award");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("meeting awards"),
			);
			await expectMembershipSurvives(membershipId);
			const [left] = await testDb
				.select({ memberId: meetingAwards.memberId })
				.from(meetingAwards)
				.where(eq(meetingAwards.id, row.id));
			expect(left?.memberId).toBe(membershipId);
		});

		// fails_when=the action-item check is dropped from the undo's checks (the
		// minutes print an open item's owner)
		it("refuses when the member owns an action item, and keeps it", async () => {
			const { guestId, membershipId } = await converted("Item Owner");
			const [row] = await testDb
				.insert(clubActionItems)
				.values({
					clubId: seed.clubId,
					text: "Book the venue",
					ownerMemberId: membershipId,
				})
				.returning({ id: clubActionItems.id });
			if (!row) throw new Error("Failed to seed action item");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("action items"),
			);
			await expectMembershipSurvives(membershipId);
			const [left] = await testDb
				.select({ owner: clubActionItems.ownerMemberId })
				.from(clubActionItems)
				.where(eq(clubActionItems.id, row.id));
			expect(left?.owner).toBe(membershipId);
		});

		it("on a REUSED lapsed membership the undo deletes nothing, so those rows do not block it", async () => {
			const email = `lapsed-${randomUUID()}@example.com`;
			const [person] = await testDb
				.insert(people)
				.values({ name: "Lapsed Reuse", email })
				.returning({ id: people.id });
			if (!person) throw new Error("Failed to seed person");
			strayPeople.push(person.id);
			const [lapsed] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: person.id,
					name: "Lapsed Reuse",
					status: "inactive",
				})
				.returning({ id: members.id });
			if (!lapsed) throw new Error("Failed to seed lapsed membership");
			await testDb.insert(meetingAttendance).values({
				meetingId: seed.meetingId,
				memberId: lapsed.id,
				status: "present",
			});
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: seed.meetingId, memberId: lapsed.id });
			await testDb.insert(clubActionItems).values({
				clubId: seed.clubId,
				text: "Reuse item",
				ownerMemberId: lapsed.id,
			});
			await testDb.insert(meetingAwards).values({
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: lapsed.id,
			});

			const guestId = await seedGuest("Lapsed Reuse Guest");
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
				confirmedEmail: email,
			});

			const res = await undo(guestId);
			expect(res.membershipDeleted).toBe(false);
			await expectMembershipSurvives(lapsed.id);
			// Nothing was deleted, so every seeded row still names the member.
			const stillNamed = async (table: PgTable, col: PgColumn) =>
				(await testDb.select({ v: col }).from(table).where(eq(col, lapsed.id)))
					.length;
			expect(
				await stillNamed(meetingAttendance, meetingAttendance.memberId),
			).toBe(1);
			expect(
				await stillNamed(tableTopicsSpeakers, tableTopicsSpeakers.memberId),
			).toBe(1);
			expect(await stillNamed(meetingAwards, meetingAwards.memberId)).toBe(1);
			expect(
				await stillNamed(clubActionItems, clubActionItems.ownerMemberId),
			).toBe(1);
		});
	},
);

/**
 * DB-backed tests for #1213: undoing a guest conversion deletes the membership
 * the conversion created, and the member's attendance, Table Topics turns and
 * awards (ON DELETE SET NULL) would be left nameless on the meeting's agenda and
 * minutes. `applyUndoGuestConversion` refuses instead, on the created path only
 * and only where #1189's removal rule would count the row: a past agenda, an
 * action item whose owner prints (#1324). The refusal names the remedy that works.
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the suite skips when unset.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubActionItems,
	guests,
	meetingAttendance,
	meetingAwards,
	meetings,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
	roleSlots,
	speeches,
	tableTopicsSpeakers,
} from "#/db/schema";
import {
	UNDO_MEMBER_HAS_HISTORY_MESSAGE,
	UNDO_MEMBER_NAME_HISTORY_MESSAGE,
} from "#/lib/guest-convert";
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

		const DAY = 24 * 60 * 60 * 1000;
		async function meetingAt(
			offsetDays: number,
			status: "scheduled" | "completed" | "cancelled" = "scheduled",
		) {
			const [m] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() + offsetDays * DAY),
					status,
				})
				.returning({ id: meetings.id });
			if (!m) throw new Error("Failed to seed meeting");
			return m.id;
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
			const past = await meetingAt(-3);
			const [row] = await testDb
				.insert(meetingAttendance)
				.values({ meetingId: past, memberId: membershipId, status })
				.returning({ id: meetingAttendance.id });
			if (!row) throw new Error("Failed to seed attendance");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_NAME_HISTORY_MESSAGE("meeting attendance"),
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
				.values({ meetingId: await meetingAt(-3), memberId: membershipId })
				.returning({ id: tableTopicsSpeakers.id });
			if (!row) throw new Error("Failed to seed Table Topics turn");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_NAME_HISTORY_MESSAGE("Table Topics turns"),
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
					meetingId: await meetingAt(-3, "completed"),
					category: "best_speaker",
					memberId: membershipId,
				})
				.returning({ id: meetingAwards.id });
			if (!row) throw new Error("Failed to seed award");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_NAME_HISTORY_MESSAGE("meeting awards"),
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
		it("refuses when the member owns an open action item and a past meeting prints it, and keeps it", async () => {
			const { guestId, membershipId } = await converted("Item Owner");
			await meetingAt(-2);
			const [row] = await testDb
				.insert(clubActionItems)
				.values({
					clubId: seed.clubId,
					text: "Book the venue",
					ownerMemberId: membershipId,
					createdAt: new Date(Date.now() - 10 * DAY),
				})
				.returning({ id: clubActionItems.id });
			if (!row) throw new Error("Failed to seed action item");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_NAME_HISTORY_MESSAGE("action items"),
			);
			await expectMembershipSurvives(membershipId);
			const [left] = await testDb
				.select({ owner: clubActionItems.ownerMemberId })
				.from(clubActionItems)
				.where(eq(clubActionItems.id, row.id));
			expect(left?.owner).toBe(membershipId);
		});

		// protects=the undo's refusal is scoped to #1189's removal rule (#1324);
		// fails_when=the past-agenda predicate is dropped from the name checks
		it.each([
			["an upcoming meeting", 3, "scheduled"],
			["a cancelled upcoming meeting", 3, "cancelled"],
			["a cancelled past meeting", -3, "cancelled"],
		] as const)("an absent mark on %s does not block the undo", async (_what, offset, status) => {
			const { guestId, membershipId } = await converted(`Marked ${offset}`);
			await testDb.insert(meetingAttendance).values({
				meetingId: await meetingAt(offset, status),
				memberId: membershipId,
				status: "absent",
			});
			const res = await undo(guestId);
			expect(res.membershipDeleted).toBe(true);
		});

		// fails_when=the `status = 'completed'` arm of pastAgendaMeeting is dropped
		it("a completed meeting dated in the FUTURE still counts as past and blocks it", async () => {
			const { guestId, membershipId } = await converted("Completed Early");
			await testDb.insert(meetingAttendance).values({
				meetingId: await meetingAt(3, "completed"),
				memberId: membershipId,
				status: "present",
			});
			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_NAME_HISTORY_MESSAGE("meeting attendance"),
			);
		});

		// fails_when=the meetings.clubId filter is dropped from hasRowOnPastAgenda.
		// Reachable only by a direct insert (the app never writes another club's
		// meeting against this club's membership), which is what the filter guards.
		it("a row on ANOTHER club's past meeting does not block it", async () => {
			const { guestId, membershipId } = await converted("Cross Club Row");
			const other = await seedClub();
			try {
				const [m] = await testDb
					.insert(meetings)
					.values({
						clubId: other.clubId,
						scheduledAt: new Date(Date.now() - 3 * DAY),
						status: "scheduled",
					})
					.returning({ id: meetings.id });
				if (!m) throw new Error("Failed to seed meeting");
				await testDb.insert(meetingAttendance).values({
					meetingId: m.id,
					memberId: membershipId,
					status: "present",
				});
				expect((await undo(guestId)).membershipDeleted).toBe(true);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("a Table Topics turn and an award on an upcoming meeting do not block it", async () => {
			const { guestId, membershipId } = await converted("Upcoming Rows");
			const upcoming = await meetingAt(4);
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: upcoming, memberId: membershipId });
			await testDb.insert(meetingAwards).values({
				meetingId: upcoming,
				category: "best_speaker",
				memberId: membershipId,
			});
			expect((await undo(guestId)).membershipDeleted).toBe(true);
		});

		it("an action item no past meeting prints with its owner does not block it", async () => {
			const { guestId, membershipId } = await converted("Quiet Items");
			// NO meeting is in the item's window: the only meeting (-2d) falls after
			// the item was resolved (-5d), so it prints the text without the owner.
			await meetingAt(-2);
			await testDb.insert(clubActionItems).values({
				clubId: seed.clubId,
				text: "Resolved before the meeting",
				ownerMemberId: membershipId,
				createdAt: new Date(Date.now() - 10 * DAY),
				resolvedAt: new Date(Date.now() - 5 * DAY),
				resolution: "done",
			});
			expect((await undo(guestId)).membershipDeleted).toBe(true);
		});

		it("the name refusal names the remedy that works, not the merge tool", () => {
			const message = UNDO_MEMBER_NAME_HISTORY_MESSAGE("meeting attendance");
			expect(message).toContain("inactive or former");
			expect(message).not.toContain("merge");
		});

		async function lapsedWithSlots(
			name: string,
			slotOffsetsDays: number[],
			priorStatus: "inactive" | "former" = "inactive",
		) {
			const email = `slot-${randomUUID()}@example.com`;
			const [person] = await testDb
				.insert(people)
				.values({ name, email })
				.returning({ id: people.id });
			if (!person) throw new Error("Failed to seed person");
			strayPeople.push(person.id);
			const [lapsed] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: person.id,
					name,
					status: priorStatus,
					...(priorStatus === "former" ? { endedAt: "2020-01-15" } : {}),
				})
				.returning({ id: members.id });
			if (!lapsed) throw new Error("Failed to seed lapsed membership");
			const slotIds: string[] = [];
			for (const offset of slotOffsetsDays) {
				const [slot] = await testDb
					.insert(roleSlots)
					.values({
						meetingId: await meetingAt(offset),
						roleDefinitionId: seed.roleDefinitionId,
						status: "claimed",
						assignedMemberId: lapsed.id,
					})
					.returning({ id: roleSlots.id });
				if (!slot) throw new Error("Failed to seed slot");
				slotIds.push(slot.id);
			}
			const guestId = await seedGuest(`${name} Guest`);
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
				confirmedEmail: email,
			});
			return { guestId, membershipId: lapsed.id, slotIds };
		}

		async function slotState(slotId: string) {
			const [row] = await testDb
				.select({
					holder: roleSlots.assignedMemberId,
					status: roleSlots.status,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId));
			return row;
		}

		// fails_when=the held-slots refusal runs on the reuse path again, or the
		// reuse path stops releasing the upcoming slot when it writes a lapsed status
		// (a state applySetMemberStatus never produces: inactive and still cast)
		it.each([
			"inactive",
			"former",
		] as const)("a REUSED %s membership holding an UPCOMING slot undoes and the slot is released", async (prior) => {
			const { guestId, membershipId, slotIds } = await lapsedWithSlots(
				`Upcoming ${prior}`,
				[5],
				prior,
			);
			const res = await undo(guestId);
			expect(res.membershipDeleted).toBe(false);
			const [m] = await testDb
				.select({ status: members.status })
				.from(members)
				.where(eq(members.id, membershipId));
			expect(m?.status).toBe(prior);
			expect(await slotState(slotIds[0] as string)).toEqual({
				holder: null,
				status: "open",
			});
		});

		// fails_when=the release drops its `scheduledAt >= now` predicate
		it("a REUSED membership's slot on a PAST meeting stays held", async () => {
			const { guestId, membershipId, slotIds } = await lapsedWithSlots(
				"Past Slot",
				[-4, 5],
			);
			await undo(guestId);
			expect(await slotState(slotIds[0] as string)).toEqual({
				holder: membershipId,
				status: "claimed",
			});
			expect((await slotState(slotIds[1] as string))?.holder).toBeNull();
		});

		// fails_when=the release runs on the leave-alone (changed_since) branch
		it("a REUSED membership the undo leaves alone (changed_since) keeps its upcoming slot", async () => {
			const { guestId, membershipId, slotIds } = await lapsedWithSlots(
				"Changed Since",
				[5],
			);
			await testDb.insert(activityLog).values({
				clubId: seed.clubId,
				actorMemberId: seed.adminMemberId,
				action: "member_edit",
				targetType: "member",
				targetId: membershipId,
				detail: { after: { status: "active" } },
			});
			const res = await undo(guestId);
			expect(res.membershipDeleted).toBe(false);
			const [m] = await testDb
				.select({ status: members.status })
				.from(members)
				.where(eq(members.id, membershipId));
			expect(m?.status).toBe("active");
			expect((await slotState(slotIds[0] as string))?.holder).toBe(
				membershipId,
			);
		});

		// fails_when=countBlankedKeys stops counting the name-blanking keys
		it("names an upcoming-meeting attendance row on the member_remove record's blanked map", async () => {
			const { guestId, membershipId } = await converted("Blanked Attendance");
			await testDb.insert(meetingAttendance).values({
				meetingId: await meetingAt(4),
				memberId: membershipId,
				status: "absent",
			});
			expect((await undo(guestId)).membershipDeleted).toBe(true);
			const [row] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_remove"),
						eq(activityLog.targetId, membershipId),
					),
				)
				.orderBy(desc(activityLog.createdAt))
				.limit(1);
			expect(
				(row?.detail as { blanked?: Record<string, number> }).blanked,
			).toEqual({ "meeting_attendance.member_id": 1 });
		});

		// fails_when=the speech count reads every speech the Person has again.
		// The Person is fresh; the speech's created_at is BACKDATED to stand in for
		// history from before the convert (speeches carry no club).
		it("a speech with a created_at before the convert (backdated; stands for another club's history) does not block the undo", async () => {
			const old = await converted("Visiting Speaker");
			await testDb.insert(speeches).values({
				personId: old.personId,
				title: "Home club speech",
				createdAt: new Date(Date.now() - 30 * DAY),
			});
			expect((await undo(old.guestId)).membershipDeleted).toBe(true);
		});

		it("a speech made AFTER the convert still blocks it", async () => {
			const old = await converted("Speaks Later");
			await testDb
				.insert(speeches)
				.values({ personId: old.personId, title: "Club speech" });
			await expect(undo(old.guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("speeches"),
			);
		});

		async function enrolCredited(personId: string, clubId: string) {
			const [path] = await testDb
				.insert(pathwaysPaths)
				.values({ courseCode: `t-${randomUUID()}`, name: "Test Path" })
				.returning({ id: pathwaysPaths.id });
			if (!path) throw new Error("Failed to seed path");
			const [enrol] = await testDb
				.insert(pathEnrollments)
				.values({ personId, pathId: path.id })
				.returning({ id: pathEnrollments.id });
			if (!enrol) throw new Error("Failed to seed enrolment");
			await testDb.insert(pathLevelProgress).values({
				enrollmentId: enrol.id,
				level: 1,
				completed: 1,
				total: 4,
				// Reachable state: creditedClubId is stamped only when a level flips to
				// approved (ADR-0022).
				approved: true,
				creditedClubId: clubId,
			});
		}

		it("an enrolment credited to ANOTHER club does not block the undo", async () => {
			const old = await converted("Enrolled Elsewhere");
			const other = await seedClub();
			try {
				await enrolCredited(old.personId, other.clubId);
				expect((await undo(old.guestId)).membershipDeleted).toBe(true);
			} finally {
				await testDb
					.delete(pathEnrollments)
					.where(eq(pathEnrollments.personId, old.personId));
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("an enrolment credited to THIS club blocks it", async () => {
			const old = await converted("Enrolled Here");
			await enrolCredited(old.personId, seed.clubId);
			await expect(undo(old.guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("a Pathways enrolment"),
			);
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

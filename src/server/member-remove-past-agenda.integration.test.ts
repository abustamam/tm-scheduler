/**
 * #1189: removing a member must not blank their name on a past agenda. The four
 * `member_id` keys that print a name (role slot holder, attendance, Table Topics
 * speaker, award winner) are ON DELETE SET NULL, so `applyMemberRemove` refuses a
 * member who is on a PAST meeting (completed, or time passed and not cancelled)
 * and points at "Mark inactive". The refusal runs before any write.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetingAttendance,
	meetingAwards,
	meetings,
	members,
	people,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { pastAgendaRemoveRefusal } from "#/lib/member-remove";
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

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("remove a member on a past agenda (#1189)", () => {
	let club: SeededClub;
	let extraPeople: string[];

	beforeEach(async () => {
		club = await seedClub();
		extraPeople = [];
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		// A removed member's Person is club-less and survives the club cascade.
		if (extraPeople.length > 0) {
			await testDb.delete(people).where(inArray(people.id, extraPeople));
		}
	});

	async function seedLeaver(name = "Leaving Lee") {
		const personId = await seedPerson({ name });
		extraPeople.push(personId);
		const [m] = await testDb
			.insert(members)
			.values({ clubId: club.clubId, personId, name })
			.returning({ id: members.id });
		return m.id;
	}

	async function seedMeeting(
		status: "scheduled" | "completed" | "cancelled",
		offsetDays: number,
	) {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + offsetDays * DAY),
				status,
			})
			.returning({ id: meetings.id });
		return m.id;
	}

	async function holdSlot(meetingId: string, memberId: string) {
		const [s] = await testDb
			.insert(roleSlots)
			.values({
				meetingId,
				roleDefinitionId: club.roleDefinitionId,
				status: "claimed",
				assignedMemberId: memberId,
			})
			.returning({ id: roleSlots.id });
		return s.id;
	}

	async function remove(memberId: string) {
		const { applyMemberRemove } = await import("#/server/members-logic");
		return applyMemberRemove({
			clubId: club.clubId,
			memberId,
			actorMemberId: club.adminMemberId,
		});
	}

	async function activityCount() {
		const rows = await testDb
			.select({ id: activityLog.id })
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		return rows.length;
	}

	async function memberRowExists(memberId: string) {
		const rows = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.id, memberId));
		return rows.length === 1;
	}

	/** The refusal leaves the member, the log and the slot holder untouched. */
	async function expectRefused(memberId: string, name: string) {
		const logged = await activityCount();
		await expect(remove(memberId)).rejects.toThrow(
			pastAgendaRemoveRefusal(name),
		);
		expect(await memberRowExists(memberId)).toBe(true);
		expect(await activityCount()).toBe(logged);
	}

	it("refuses a member who holds a slot on a completed meeting", async () => {
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		const slotId = await holdSlot(meetingId, leaver);

		await expectRefused(leaver, "Leaving Lee");

		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		expect(slot?.assignedMemberId).toBe(leaver);
		expect(slot?.status).toBe("claimed");
	});

	it("refuses a slot on a past meeting that is still `scheduled`", async () => {
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", -3);
		const slotId = await holdSlot(meetingId, leaver);

		await expectRefused(leaver, "Leaving Lee");

		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		expect(slot?.assignedMemberId).toBe(leaver);
	});

	it("refuses a slot on a completed meeting whose date is still ahead", async () => {
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", 1);
		await holdSlot(meetingId, leaver);

		await expectRefused(leaver, "Leaving Lee");
	});

	it("refuses a member who appears only in attendance", async () => {
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		await testDb
			.insert(meetingAttendance)
			.values({ meetingId, memberId: leaver, status: "present" });

		await expectRefused(leaver, "Leaving Lee");

		const [row] = await testDb
			.select()
			.from(meetingAttendance)
			.where(eq(meetingAttendance.meetingId, meetingId));
		expect(row?.memberId).toBe(leaver);
	});

	it("refuses a member who appears only as a Table Topics speaker", async () => {
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		await testDb
			.insert(tableTopicsSpeakers)
			.values({ meetingId, memberId: leaver });

		await expectRefused(leaver, "Leaving Lee");

		const [row] = await testDb
			.select()
			.from(tableTopicsSpeakers)
			.where(eq(tableTopicsSpeakers.meetingId, meetingId));
		expect(row?.memberId).toBe(leaver);
	});

	it("refuses a member who appears only as an award winner", async () => {
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		await testDb
			.insert(meetingAwards)
			.values({ meetingId, category: "best_speaker", memberId: leaver });

		await expectRefused(leaver, "Leaving Lee");

		const [row] = await testDb
			.select()
			.from(meetingAwards)
			.where(eq(meetingAwards.meetingId, meetingId));
		expect(row?.memberId).toBe(leaver);
	});

	it("the refusal names the alternative", () => {
		expect(pastAgendaRemoveRefusal("Leaving Lee")).toBe(
			"Leaving Lee appears on past agendas, so removing them would blank their name there. Mark them inactive instead.",
		);
	});

	it("removes a member whose only rows are on a past CANCELLED meeting", async () => {
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("cancelled", -7);
		await holdSlot(meetingId, leaver);
		await testDb
			.insert(meetingAttendance)
			.values({ meetingId, memberId: leaver, status: "present" });

		await remove(leaver);

		expect(await memberRowExists(leaver)).toBe(false);
	});

	it("removes a member on upcoming meetings, releasing and logging their slots", async () => {
		const leaver = await seedLeaver();
		const upcoming = await seedMeeting("scheduled", 7);
		const slotId = await holdSlot(upcoming, leaver);

		await remove(leaver);

		expect(await memberRowExists(leaver)).toBe(false);
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		expect(slot?.status).toBe("open");
		expect(slot?.assignedMemberId).toBeNull();
		const released = await testDb
			.select({ id: activityLog.id })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.action, "release"),
					eq(activityLog.targetId, slotId),
				),
			);
		expect(released).toHaveLength(1);
	});

	it("removes a member with both a past-cancelled and an upcoming slot", async () => {
		const leaver = await seedLeaver();
		await holdSlot(await seedMeeting("cancelled", -7), leaver);
		const slotId = await holdSlot(await seedMeeting("scheduled", 7), leaver);

		await remove(leaver);

		expect(await memberRowExists(leaver)).toBe(false);
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		expect(slot?.status).toBe("open");
	});

	it("removes a member with no meeting rows at all", async () => {
		const leaver = await seedLeaver();

		await remove(leaver);

		expect(await memberRowExists(leaver)).toBe(false);
	});

	it("a refused member who also holds an upcoming slot keeps that slot too", async () => {
		const leaver = await seedLeaver();
		await holdSlot(await seedMeeting("completed", -7), leaver);
		const upcomingSlot = await holdSlot(
			await seedMeeting("scheduled", 7),
			leaver,
		);

		await expectRefused(leaver, "Leaving Lee");

		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, upcomingSlot));
		expect(slot?.assignedMemberId).toBe(leaver);
		expect(slot?.status).toBe("claimed");
	});

	it("refuses when a past slot is claimed by a concurrent transaction after the removal started", async () => {
		// Protects: the check and the delete are one atomic step. A slot inserted for
		// the member takes a KEY SHARE lock on the member row through the FK; the
		// removal's `for update` select waits on it, then re-reads the committed slot.
		// Fails when: the lock is dropped. The removal's check then runs on the
		// pre-commit snapshot (sees no slot), the delete waits out the FK lock, and
		// ON DELETE SET NULL blanks the holder the other transaction just committed.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		let slotId = "";
		const claimer = await openBlockingTx(async (tx) => {
			const [s] = await tx
				.insert(roleSlots)
				.values({
					meetingId,
					roleDefinitionId: club.roleDefinitionId,
					status: "claimed",
					assignedMemberId: leaver,
				})
				.returning({ id: roleSlots.id });
			slotId = s.id;
		});
		const outcome = remove(leaver).then(
			() => null,
			(e: unknown) => e,
		);
		try {
			await waitForLockWait("for update", claimer.pid);
		} finally {
			await claimer.commit();
			await outcome;
		}

		const err = await outcome;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe(pastAgendaRemoveRefusal("Leaving Lee"));
		expect(await memberRowExists(leaver)).toBe(true);
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		expect(slot?.assignedMemberId).toBe(leaver);
	});
});

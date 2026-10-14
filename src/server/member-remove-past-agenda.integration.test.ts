/**
 * #1189: removing a member must not blank their name on a past agenda. The four
 * `member_id` keys that print a name (role slot holder, attendance, Table Topics
 * speaker, award winner) are ON DELETE SET NULL, so `applyMemberRemove` refuses a
 * member who is on a PAST meeting (completed, or time passed and not cancelled)
 * and points at "Mark inactive". The refusal runs before any write.
 */
import { and, asc, eq, getTableName, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubActionItems,
	meetingAttendance,
	meetingAwards,
	meetings,
	members,
	people,
	roleSlots,
	speechRequests,
	tableTopicsSpeakers,
} from "#/db/schema";
import {
	isPastAgendaRemoveRefusal,
	pastAgendaRemoveRefusal,
} from "#/lib/member-remove";
import { CLUB_BUSY_MESSAGE } from "#/server/club-write-lock";
import { lockMeetingForSlotEdit } from "#/server/meeting-slot-lock";
import {
	lockMembershipForMerge,
	lockMembershipsAgainstMerge,
} from "#/server/membership-merge-lock";
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
		const err = await remove(memberId).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe(pastAgendaRemoveRefusal(name));
		// The remove dialog offers "Mark inactive" off this match, so what the
		// server really threw must be recognised by it.
		expect(isPastAgendaRemoveRefusal((err as Error).message)).toBe(true);
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

	/** Park `remove(leaver)` behind `blocker`, then let the blocker commit. */
	async function removeParkedBehind(
		blocker: { pid: number; commit: () => Promise<void> },
		leaver: string,
		match: string,
	) {
		const outcome = remove(leaver).then(
			() => null,
			(e: unknown) => e,
		);
		try {
			await waitForLockWait(match, blocker.pid);
		} finally {
			await blocker.commit();
			await outcome;
		}
		return outcome;
	}

	async function slotHolder(slotId: string) {
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		return slot;
	}

	it("refuses a past slot claimed through the merge lock while the removal waits", async () => {
		// Protects: a claim (`claimSlotCore`) takes the membership merge lock SHARED
		// first. The removal takes it EXCLUSIVE before any row lock, so it waits for
		// the claim to commit and then sees the slot.
		// Fails when: the removal skips that lock. It then reads before the claim
		// commits, and ON DELETE SET NULL blanks the holder the claim just committed.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		let slotId = "";
		const claimer = await openBlockingTx(async (tx) => {
			await lockMembershipsAgainstMerge(tx, [leaver]);
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
		const err = await removeParkedBehind(
			claimer,
			leaver,
			"pg_advisory_xact_lock",
		);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe(pastAgendaRemoveRefusal("Leaving Lee"));
		expect(await memberRowExists(leaver)).toBe(true);
		expect((await slotHolder(slotId))?.assignedMemberId).toBe(leaver);
	});

	it("stops, writing nothing, when a writer without the merge lock lands a row on an unheld meeting", async () => {
		// Protects: a writer that does not take the merge lock (a reassignment, an
		// attendance row) takes KEY SHARE on the member row through the FK, so the
		// removal's member row lock waits for it. The meeting it landed on was not
		// locked by the removal, so its status is not stable: the removal refuses to
		// decide on it and answers CLUB_BUSY_MESSAGE.
		// Fails when: the member row lock is dropped (the removal never parks), or
		// the unheld-meeting check is dropped (it deletes, and SET NULL blanks the
		// holder the other writer committed).
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		let slotId = "";
		const writer = await openBlockingTx(async (tx) => {
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
		const err = await removeParkedBehind(
			writer,
			leaver,
			'"members"%for update',
		);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect(await memberRowExists(leaver)).toBe(true);
		expect((await slotHolder(slotId))?.assignedMemberId).toBe(leaver);
	});

	it("stops, writing nothing, when a writer lands an attendance row on an unheld meeting", async () => {
		// Same wait as above through the other key kind: only the unheld-meeting
		// check can stop this one (there is no slot to trip the slot check).
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		const writer = await openBlockingTx(async (tx) => {
			await tx
				.insert(meetingAttendance)
				.values({ meetingId, memberId: leaver, status: "present" });
		});
		const err = await removeParkedBehind(
			writer,
			leaver,
			'"members"%for update',
		);

		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect(await memberRowExists(leaver)).toBe(true);
		const rows = await testDb
			.select()
			.from(meetingAttendance)
			.where(eq(meetingAttendance.meetingId, meetingId));
		expect(rows[0]?.memberId).toBe(leaver);
	});

	it("stops, writing nothing, when a writer lands a second slot on a meeting the removal holds", async () => {
		// The removal locked the member's slots before the member row, so a slot a
		// writer adds in between is not locked: locking it now would take a slot lock
		// AFTER the member row, against the lock order. It stops instead. Only the
		// unheld-slot check can stop this (the meeting is held).
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", 7);
		const first = await holdSlot(meetingId, leaver);
		let second = "";
		const writer = await openBlockingTx(async (tx) => {
			const [s] = await tx
				.insert(roleSlots)
				.values({
					meetingId,
					roleDefinitionId: club.roleDefinitionId,
					status: "claimed",
					assignedMemberId: leaver,
				})
				.returning({ id: roleSlots.id });
			second = s.id;
		});
		const err = await removeParkedBehind(
			writer,
			leaver,
			'"members"%for update',
		);

		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect(await memberRowExists(leaver)).toBe(true);
		expect((await slotHolder(first))?.assignedMemberId).toBe(leaver);
		expect((await slotHolder(second))?.assignedMemberId).toBe(leaver);
	});

	it("refuses a member who is a signed-in account", async () => {
		const leaver = await seedLeaver();
		await testDb
			.update(people)
			.set({ userId: club.memberUserId })
			.where(eq(people.id, extraPeople[0] ?? ""));
		const logged = await activityCount();

		await expect(remove(leaver)).rejects.toThrow(
			"That member is a signed-in account and can't be removed.",
		);

		expect(await memberRowExists(leaver)).toBe(true);
		expect(await activityCount()).toBe(logged);
	});

	it("refuses when the member's account is linked while the removal waits", async () => {
		// Protects: the sign-in check runs INSIDE the transaction, after the locks.
		// Fails when: it runs before the transaction. An invite accepted in between
		// then lets the now-signed-in member be removed.
		const leaver = await seedLeaver();
		const writer = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select id from members where id = ${leaver} for key share`,
			);
			await tx
				.update(people)
				.set({ userId: club.memberUserId })
				.where(eq(people.id, extraPeople[0] ?? ""));
		});
		const err = await removeParkedBehind(
			writer,
			leaver,
			'"members"%for update',
		);

		expect((err as Error).message).toBe(
			"That member is a signed-in account and can't be removed.",
		);
		expect(await memberRowExists(leaver)).toBe(true);
	});

	it("does not lock or wait on another club's meetings for a member that is not in this club", async () => {
		// Protects: the in-club check comes before the first lock. A removal aimed at
		// a member of another club answers "Member not found." without taking that
		// club's merge lock or meeting rows.
		// Fails when: the check is dropped. The removal then waits for the other
		// club's meeting lock held below.
		const other = await seedClub();
		try {
			const personId = await seedPerson({ name: "Elsewhere" });
			extraPeople.push(personId);
			const [foreign] = await testDb
				.insert(members)
				.values({ clubId: other.clubId, personId, name: "Elsewhere" })
				.returning({ id: members.id });
			const [fm] = await testDb
				.insert(meetings)
				.values({
					clubId: other.clubId,
					scheduledAt: new Date(Date.now() + 7 * DAY),
				})
				.returning({ id: meetings.id });
			await testDb.insert(roleSlots).values({
				meetingId: fm.id,
				roleDefinitionId: other.roleDefinitionId,
				status: "claimed",
				assignedMemberId: foreign.id,
			});
			const holder = await openBlockingTx(async (tx) => {
				await lockMeetingForSlotEdit(tx, fm.id);
			});
			try {
				let settled = false;
				const outcome = remove(foreign.id).then(
					() => {
						settled = true;
						return null;
					},
					(e: unknown) => {
						settled = true;
						return e;
					},
				);
				await Promise.race([outcome, new Promise((r) => setTimeout(r, 1500))]);
				expect(settled).toBe(true);
				expect(((await outcome) as Error).message).toBe("Member not found.");
			} finally {
				await holder.commit();
			}
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("refuses a slot whose meeting is completed while the removal waits (no nameless holder on a completed agenda)", async () => {
		// Protects: the meeting row is locked BEFORE the check, so the status the
		// check reads is the status the delete acts on. `applyCompleteMeeting` takes
		// the same lock (`lockMeetingForSlotEdit`) and writes `completed`.
		// Fails when: the removal does not lock the meeting. It then reads
		// `scheduled`, releases or deletes around a meeting that completes next, and
		// a completed agenda is left with a claimed role and no holder.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", 0.04); // later today
		const slotId = await holdSlot(meetingId, leaver);
		const completer = await openBlockingTx(async (tx) => {
			await lockMeetingForSlotEdit(tx, meetingId);
			await tx
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, meetingId));
		});
		const err = await removeParkedBehind(
			completer,
			leaver,
			"for no key update",
		);

		expect((err as Error).message).toBe(pastAgendaRemoveRefusal("Leaving Lee"));
		expect(await memberRowExists(leaver)).toBe(true);
		const slot = await slotHolder(slotId);
		expect(slot?.assignedMemberId).toBe(leaver);
		expect(slot?.status).toBe("claimed");
	});

	it("refuses a slot whose meeting is rescheduled into the past while the removal waits", async () => {
		// Same lock, other writer: a reschedule is a plain UPDATE of the meeting row,
		// which conflicts with the removal's `for no key update` on it.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", 3);
		const slotId = await holdSlot(meetingId, leaver);
		const rescheduler = await openBlockingTx(async (tx) => {
			await tx
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - DAY) })
				.where(eq(meetings.id, meetingId));
		});
		const err = await removeParkedBehind(
			rescheduler,
			leaver,
			"for no key update",
		);

		expect((err as Error).message).toBe(pastAgendaRemoveRefusal("Leaving Lee"));
		expect(await memberRowExists(leaver)).toBe(true);
		expect((await slotHolder(slotId))?.assignedMemberId).toBe(leaver);
	});

	it("finishes beside an assign_roles-style batch without a deadlock", async () => {
		// `assign_roles` locks the meeting, then its slots in id order, then assigns
		// one to a member (FK KEY SHARE on the member row). The removal takes the
		// meeting FIRST, so it queues behind that batch holding no row lock, and the
		// batch is never waiting on a lock the removal holds. The first version took
		// the member row first: it held it, wanted the batch's slot, and the batch
		// wanted the member row: 40P01.
		// Fails when: the removal locks the member row (or the slots) before the
		// meeting: the removal never parks on the meeting lock, and the interleaving
		// below deadlocks or times out.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", 7);
		const held = await holdSlot(meetingId, leaver);
		const [spare] = await testDb
			.insert(roleSlots)
			.values({
				meetingId,
				roleDefinitionId: club.roleDefinitionId,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		const slotIds = [held, spare.id];

		let proceed!: () => void;
		const gate = new Promise<void>((r) => {
			proceed = r;
		});
		let holdsLocks!: (pid: number) => void;
		const holding = new Promise<number>((r) => {
			holdsLocks = r;
		});
		const batch = testDb.transaction(async (tx) => {
			const res = await tx.execute(sql`select pg_backend_pid() as pid`);
			const pid = Number((res.rows[0] as { pid: number }).pid);
			await lockMeetingForSlotEdit(tx, meetingId);
			await tx
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(inArray(roleSlots.id, slotIds))
				.orderBy(asc(roleSlots.id))
				.for("update");
			holdsLocks(pid);
			await gate;
			await tx
				.update(roleSlots)
				.set({ assignedMemberId: leaver, status: "claimed" })
				.where(eq(roleSlots.id, spare.id));
		});
		const batchOutcome = batch.then(
			() => null,
			(e: unknown) => e,
		);
		const batchPid = await holding;
		const removal = remove(leaver).then(
			() => null,
			(e: unknown) => e,
		);
		try {
			await waitForLockWait("for no key update", batchPid);
		} finally {
			proceed();
		}
		expect(await batchOutcome).toBeNull();
		expect(await removal).toBeNull();

		// The batch's assignment committed before the removal got its locks, so the
		// removal saw and released both slots.
		expect(await memberRowExists(leaver)).toBe(false);
		for (const id of slotIds) {
			const slot = await slotHolder(id);
			expect(slot?.assignedMemberId).toBeNull();
			expect(slot?.status).toBe("open");
		}
	});

	it("treats a meeting starting exactly now as upcoming: released, not refused", async () => {
		// One clock: past is `scheduledAt < now`, release is `scheduledAt >= now`,
		// on the same `now`, so a meeting is on exactly one side. Fails when either
		// comparison moves: `<=` refuses it, `>` neither refuses nor releases it,
		// and the delete blanks a slot on a meeting that is about to start.
		const leaver = await seedLeaver();
		const at = new Date(Math.floor(Date.now() / 1000) * 1000);
		const [m] = await testDb
			.insert(meetings)
			.values({ clubId: club.clubId, scheduledAt: at, status: "scheduled" })
			.returning({ id: meetings.id });
		const slotId = await holdSlot(m.id, leaver);

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(at);
		try {
			await remove(leaver);
		} finally {
			vi.useRealTimers();
		}

		expect(await memberRowExists(leaver)).toBe(false);
		const slot = await slotHolder(slotId);
		expect(slot?.status).toBe("open");
		expect(slot?.assignedMemberId).toBeNull();
	});

	it("stops with a plain message when the member row is gone", async () => {
		const leaver = await seedLeaver();
		await remove(leaver);
		await expect(remove(leaver)).rejects.toThrow("Member not found.");
	});

	// Action items (#1189, maintainer decision: minutes are part of the meeting's
	// record). An item has no meeting; the minutes of meeting P print it, with its
	// owner, when createdAt <= P.scheduledAt and it is open at that instant. So an
	// owner blocks removal when a PAST meeting falls inside the item's open window.
	async function seedItem(
		ownerId: string,
		createdOffsetDays: number,
		resolvedOffsetDays: number | null,
	) {
		const [item] = await testDb
			.insert(clubActionItems)
			.values({
				clubId: club.clubId,
				text: "Book the venue",
				ownerMemberId: ownerId,
				createdAt: new Date(Date.now() + createdOffsetDays * DAY),
				...(resolvedOffsetDays === null
					? {}
					: {
							resolvedAt: new Date(Date.now() + resolvedOffsetDays * DAY),
							resolution: "done" as const,
						}),
			})
			.returning({ id: clubActionItems.id });
		return item.id;
	}

	async function itemOwner(itemId: string) {
		const [row] = await testDb
			.select({ ownerMemberId: clubActionItems.ownerMemberId })
			.from(clubActionItems)
			.where(eq(clubActionItems.id, itemId));
		return row?.ownerMemberId ?? null;
	}

	it("refuses an owner of an open action item that a COMPLETED past meeting's minutes print", async () => {
		const leaver = await seedLeaver();
		await seedMeeting("completed", -7);
		const itemId = await seedItem(leaver, -30, null);

		await expectRefused(leaver, "Leaving Lee");

		expect(await itemOwner(itemId)).toBe(leaver);
	});

	it("refuses an owner whose item is open at a past meeting that is still `scheduled`", async () => {
		const leaver = await seedLeaver();
		await seedMeeting("scheduled", -3);
		const itemId = await seedItem(leaver, -30, null);

		await expectRefused(leaver, "Leaving Lee");

		expect(await itemOwner(itemId)).toBe(leaver);
	});

	it("refuses an owner whose item was closed only AFTER the past meeting", async () => {
		// Closed at -2, meeting at -7: the item was open at that meeting, so its
		// minutes print the owner even though the item is closed now.
		const leaver = await seedLeaver();
		await seedMeeting("completed", -7);
		const itemId = await seedItem(leaver, -30, -2);

		await expectRefused(leaver, "Leaving Lee");

		expect(await itemOwner(itemId)).toBe(leaver);
	});

	it("removes an owner whose item was closed BEFORE the only past meeting (closed items print no owner)", async () => {
		const leaver = await seedLeaver();
		await seedMeeting("completed", -7);
		const itemId = await seedItem(leaver, -30, -20);

		await remove(leaver);

		expect(await memberRowExists(leaver)).toBe(false);
		expect(await itemOwner(itemId)).toBeNull();
	});

	it("removes an owner whose item was created AFTER the only past meeting", async () => {
		const leaver = await seedLeaver();
		await seedMeeting("completed", -7);
		const itemId = await seedItem(leaver, -2, null);

		await remove(leaver);

		expect(await memberRowExists(leaver)).toBe(false);
		expect(await itemOwner(itemId)).toBeNull();
	});

	it("treats an item closed exactly at a past meeting's instant as closed there", async () => {
		// `openAsOf`: resolved exactly at the instant counts as closed.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		const [m] = await testDb
			.select({ at: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		await testDb.insert(clubActionItems).values({
			clubId: club.clubId,
			text: "Book the venue",
			ownerMemberId: leaver,
			createdAt: new Date(m.at.getTime() - 30 * DAY),
			resolvedAt: m.at,
			resolution: "done",
		});

		await remove(leaver);

		expect(await memberRowExists(leaver)).toBe(false);
	});

	it("removes an owner whose item is open only across upcoming and past CANCELLED meetings", async () => {
		const leaver = await seedLeaver();
		await seedMeeting("cancelled", -7);
		await seedMeeting("scheduled", 7);
		const itemId = await seedItem(leaver, -30, null);

		await remove(leaver);

		expect(await memberRowExists(leaver)).toBe(false);
		// The item survives with no owner, as `ON DELETE SET NULL` leaves it.
		expect(await itemOwner(itemId)).toBeNull();
		const rows = await testDb
			.select({ id: clubActionItems.id })
			.from(clubActionItems)
			.where(eq(clubActionItems.id, itemId));
		expect(rows).toHaveLength(1);
	});

	it("ignores another club's past meeting inside the item's window", async () => {
		// Minutes are per club: a meeting of ANOTHER club prints none of this club's
		// action items. Fails when the window join is not scoped to the club.
		const other = await seedClub();
		try {
			await testDb.insert(meetings).values({
				clubId: other.clubId,
				scheduledAt: new Date(Date.now() - 7 * DAY),
				status: "completed",
			});
			const leaver = await seedLeaver();
			const itemId = await seedItem(leaver, -30, null);

			await remove(leaver);

			expect(await memberRowExists(leaver)).toBe(false);
			expect(await itemOwner(itemId)).toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("removes an owner of an open item when the club has only its upcoming meeting", async () => {
		const leaver = await seedLeaver();
		const itemId = await seedItem(leaver, -30, null);

		await remove(leaver);

		expect(await memberRowExists(leaver)).toBe(false);
		expect(await itemOwner(itemId)).toBeNull();
	});

	it("refuses an item's owner when a meeting in the item's window is completed while the removal waits", async () => {
		// Protects: the meetings an action item's minutes print on are locked before
		// the check, though no row names them. Fails when only meetings the member is
		// on (slots, attendance, ...) are locked: the removal then reads `scheduled`
		// and deletes around a meeting that completes next.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", 0.04); // later today
		const itemId = await seedItem(leaver, -30, null);
		const completer = await openBlockingTx(async (tx) => {
			await lockMeetingForSlotEdit(tx, meetingId);
			await tx
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, meetingId));
		});
		const err = await removeParkedBehind(
			completer,
			leaver,
			"for no key update",
		);

		expect((err as Error).message).toBe(pastAgendaRemoveRefusal("Leaving Lee"));
		expect(await memberRowExists(leaver)).toBe(true);
		expect(await itemOwner(itemId)).toBe(leaver);
	});

	it("stops, writing nothing, when an owned item is reopened while the removal waits", async () => {
		// Protects: the removal locks the member's action items. A reopen widens the
		// item's window to the past meeting, so deciding before it commits would
		// delete the owner of an item the minutes now print.
		// Fails when: the item lock is dropped (the removal never parks on it).
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("completed", -7);
		const itemId = await seedItem(leaver, -30, -20);
		const reopener = await openBlockingTx(async (tx) => {
			await tx
				.update(clubActionItems)
				.set({ resolvedAt: null, resolution: null })
				.where(eq(clubActionItems.id, itemId));
		});
		const err = await removeParkedBehind(
			reopener,
			leaver,
			'"club_action_items"%for update',
		);

		// The reopened item now reaches the past meeting, which this removal did not
		// hold: it stops rather than judge it.
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect(await memberRowExists(leaver)).toBe(true);
		expect(await itemOwner(itemId)).toBe(leaver);
		expect(meetingId).toBeTruthy();
	});

	it("stops, writing nothing, when a writer gives the member a new action item while the removal waits", async () => {
		// Only the unheld-item check can stop this: no meeting or slot is involved.
		// The new item's FK takes KEY SHARE on the member row, so the removal's member
		// row lock waits for it.
		const leaver = await seedLeaver();
		let itemId = "";
		const writer = await openBlockingTx(async (tx) => {
			const [item] = await tx
				.insert(clubActionItems)
				.values({
					clubId: club.clubId,
					text: "Book the venue",
					ownerMemberId: leaver,
					// Created far ahead so no meeting falls in its window: the
					// meeting check cannot be what stops the removal.
					createdAt: new Date(Date.now() + 3650 * DAY),
				})
				.returning({ id: clubActionItems.id });
			itemId = item.id;
		});
		const err = await removeParkedBehind(
			writer,
			leaver,
			'"members"%for update',
		);

		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect(await memberRowExists(leaver)).toBe(true);
		expect(await itemOwner(itemId)).toBe(leaver);
	});

	// ---- "The merge lock first": the second review round (#1189) ----

	/** Did `err` come from Postgres reporting a deadlock (40P01)? Walks the cause chain. */
	function isDeadlock(err: unknown): boolean {
		for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
			const o = e as { code?: string; message?: string; cause?: unknown };
			if (o.code === "40P01" || /deadlock detected/i.test(o.message ?? "")) {
				return true;
			}
			e = o.cause;
		}
		return false;
	}

	/**
	 * Park a removal of `leaver` at its action-item lock, AFTER it holds the
	 * member's meetings and slots and BEFORE it takes the member row: the exact
	 * window the round-1 order left open. `blockerItem` is an item the leaver owns,
	 * held by a transaction we control. Returns the removal's backend pid, the
	 * promise of its outcome and the blocker.
	 */
	async function removalParkedAtItems(leaver: string) {
		const itemId = await seedItem(leaver, -1, null);
		const blocker = await openBlockingTx(async (tx) => {
			await tx
				.select({ id: clubActionItems.id })
				.from(clubActionItems)
				.where(eq(clubActionItems.id, itemId))
				.for("update");
		});
		const outcome = remove(leaver).then(
			() => null,
			(e: unknown) => e,
		);
		const removalPid = await waitForLockWait(
			'"club_action_items"%for update',
			blocker.pid,
		);
		return { blocker, outcome, removalPid, itemId };
	}

	it("deactivate and remove of one member both finish, with no deadlock", async () => {
		// Protects: deactivate takes the membership merge lock SHARED before it writes
		// anything. The removal (parked below holding the member's meetings and slots)
		// holds it EXCLUSIVE, so deactivate waits for the whole removal. Without it
		// deactivate updated the member row FIRST, then asked for the slot the removal
		// holds, while the removal's next lock is that member row: 40P01.
		// Fails when: deactivate's lock is dropped (a deadlock is raised for one of
		// the two) or the removal stops taking the lock exclusive.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", 7);
		const slotId = await holdSlot(meetingId, leaver);
		const { applySetMemberStatus } = await import("#/server/members-logic");

		const { blocker, outcome, removalPid } = await removalParkedAtItems(leaver);
		const deactivation = applySetMemberStatus({
			clubId: club.clubId,
			memberId: leaver,
			status: "inactive",
			actorMemberId: club.adminMemberId,
		}).then(
			() => null,
			(e: unknown) => e,
		);
		try {
			// Blocked BY the removal: on the merge lock when protected, on the slot
			// it holds when not.
			await waitForLockWait("", removalPid);
		} finally {
			await blocker.commit();
		}
		const removalErr = await outcome;
		const deactivateErr = await deactivation;

		expect(isDeadlock(removalErr)).toBe(false);
		expect(isDeadlock(deactivateErr)).toBe(false);
		// The removal won, completely; deactivate then found the member gone.
		expect(removalErr).toBeNull();
		expect((deactivateErr as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect(await memberRowExists(leaver)).toBe(false);
		const slot = await slotHolder(slotId);
		expect(slot?.assignedMemberId).toBeNull();
		expect(slot?.status).toBe("open");
	});

	it("reactivating a member also queues behind a removal of that member", async () => {
		// Same lock, other direction of the status change: an inactive member with an
		// upcoming slot is removed while a reactivation waits.
		const leaver = await seedLeaver();
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, leaver));
		const meetingId = await seedMeeting("scheduled", 7);
		await holdSlot(meetingId, leaver);
		const { applySetMemberStatus } = await import("#/server/members-logic");

		const { blocker, outcome, removalPid } = await removalParkedAtItems(leaver);
		const reactivation = applySetMemberStatus({
			clubId: club.clubId,
			memberId: leaver,
			status: "active",
			actorMemberId: club.adminMemberId,
		}).then(
			() => null,
			(e: unknown) => e,
		);
		try {
			await waitForLockWait("pg_advisory_xact_lock_shared", removalPid);
		} finally {
			await blocker.commit();
		}
		expect(await outcome).toBeNull();
		expect((await reactivation) as Error).toHaveProperty(
			"message",
			CLUB_BUSY_MESSAGE,
		);
		expect(await memberRowExists(leaver)).toBe(false);
	});

	it("scheduling the member's speech request and removing the member both finish, with no deadlock", async () => {
		// Protects: `scheduleSpeechRequest` takes the merge lock SHARED before it locks
		// the request row or the meeting. The removal holds the meeting and its DELETE
		// cascades to that request row (ON DELETE CASCADE). Without the lock, Schedule
		// held the request row and waited for the meeting, and the removal then
		// waited for the row: 40P01.
		// Fails when: Schedule's lock is dropped, or comes after the request row lock.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", 7);
		// The leaver's footprint on that meeting, so the removal holds it.
		await testDb
			.insert(meetingAttendance)
			.values({ meetingId, memberId: leaver, status: "present" });
		const [target] = await testDb
			.insert(roleSlots)
			.values({
				meetingId,
				roleDefinitionId: club.roleDefinitionId,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		const [request] = await testDb
			.insert(speechRequests)
			.values({
				clubId: club.clubId,
				membershipId: leaver,
				title: "Ice Breaker",
			})
			.returning({ id: speechRequests.id });
		const { scheduleSpeechRequest } = await import(
			"#/server/speech-requests-logic"
		);

		const { blocker, outcome, removalPid } = await removalParkedAtItems(leaver);
		const scheduling = scheduleSpeechRequest({
			requestId: request.id,
			slotId: target.id,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		}).then(
			() => null,
			(e: unknown) => e,
		);
		try {
			await waitForLockWait("", removalPid);
		} finally {
			await blocker.commit();
		}
		const removalErr = await outcome;
		const scheduleErr = await scheduling;

		expect(isDeadlock(removalErr)).toBe(false);
		expect(isDeadlock(scheduleErr)).toBe(false);
		expect(removalErr).toBeNull();
		// The request went with the member (cascade); Schedule found it gone.
		expect((scheduleErr as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect(await memberRowExists(leaver)).toBe(false);
		const left = await testDb
			.select({ id: speechRequests.id })
			.from(speechRequests)
			.where(eq(speechRequests.id, request.id));
		expect(left).toHaveLength(0);
		expect((await slotHolder(target.id))?.status).toBe("open");
	});

	it("scheduling a request for a request of another club is refused as not found at once, before ANY lock", async () => {
		// Protects: the unlocked read that finds the requester for the lock keeps the
		// old answer for a request that is not this club's, and gives it BEFORE the
		// merge lock, the request row lock and the meeting lock. Another transaction
		// holds all three (the merge lock exclusive, the request row, the meeting row)
		// and the wrong-club call still comes back not-found immediately.
		// Fails when: the club check moves behind the merge lock or the request row
		// lock: the call then waits for the blocker and gives up after its 5 s lock
		// timeout, so it has not settled within the bound below.
		const leaver = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", 7);
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId,
				roleDefinitionId: club.roleDefinitionId,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		const [request] = await testDb
			.insert(speechRequests)
			.values({ clubId: club.clubId, membershipId: leaver })
			.returning({ id: speechRequests.id });
		const { scheduleSpeechRequest } = await import(
			"#/server/speech-requests-logic"
		);
		const holder = await openBlockingTx(async (tx) => {
			await lockMembershipForMerge(tx, leaver);
			await tx
				.select({ id: speechRequests.id })
				.from(speechRequests)
				.where(eq(speechRequests.id, request.id))
				.for("update");
			await lockMeetingForSlotEdit(tx, meetingId);
		});
		try {
			const outcome = scheduleSpeechRequest({
				requestId: request.id,
				slotId: slot.id,
				clubId: "00000000-0000-4000-8000-000000000000",
				actorMemberId: null,
			}).then(
				() => null,
				(e: unknown) => e,
			);
			expect(await settlesWithin(outcome, 1500)).toBe(true);
			expect((await outcome) as Error).toHaveProperty(
				"message",
				"That speech request was not found.",
			);
		} finally {
			await holder.commit();
		}
	});

	/** True if `p` settles within `ms`. */
	async function settlesWithin(p: Promise<unknown>, ms: number) {
		let settled = false;
		void p.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.race([p, new Promise((r) => setTimeout(r, ms))]).catch(
			() => {},
		);
		return settled;
	}

	it("refuses a member with past history at once, taking no merge lock and no meeting lock", async () => {
		// Protects: the early refusal runs on plain reads before ANY lock. Another
		// transaction holds everything the locked path would ask for (the merge lock
		// exclusive, the past meeting, the member's slot, the member row) and the
		// refusal still comes back immediately, with the same text the locked path
		// gives.
		// Fails when: the early refusal is dropped: the removal then waits for the
		// merge lock held below, and gives up after its 5 s lock timeout with
		// CLUB_BUSY_MESSAGE.
		const leaver = await seedLeaver();
		const pastMeeting = await seedMeeting("completed", -7);
		await holdSlot(pastMeeting, leaver);
		const holder = await openBlockingTx(async (tx) => {
			await lockMembershipForMerge(tx, leaver);
			await lockMeetingForSlotEdit(tx, pastMeeting);
			await tx
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.assignedMemberId, leaver))
				.for("update");
			await tx
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, leaver))
				.for("update");
		});
		try {
			const outcome = remove(leaver).then(
				() => null,
				(e: unknown) => e,
			);
			expect(await settlesWithin(outcome, 1500)).toBe(true);
			const early = (await outcome) as Error;
			expect(early.message).toBe(pastAgendaRemoveRefusal("Leaving Lee"));
			expect(isPastAgendaRemoveRefusal(early.message)).toBe(true);
		} finally {
			await holder.commit();
		}
		expect(await memberRowExists(leaver)).toBe(true);

		// The locked path (a meeting completed while the removal waits) gives the
		// identical error for an identically named member.
		const other = await seedLeaver();
		const meetingId = await seedMeeting("scheduled", 0.04);
		await holdSlot(meetingId, other);
		const completer = await openBlockingTx(async (tx) => {
			await lockMeetingForSlotEdit(tx, meetingId);
			await tx
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, meetingId));
		});
		const locked = (await removeParkedBehind(
			completer,
			other,
			"for no key update",
		)) as Error;
		expect(locked.message).toBe(pastAgendaRemoveRefusal("Leaving Lee"));
	});

	it("a signed-in member on a past agenda gets the signed-in refusal at once, before any lock", async () => {
		// Protects: the early signed-in check. It keeps the locked path's order (the
		// account check first) AND runs before any lock: another transaction holds the
		// merge lock exclusive and the member row, and the signed-in refusal still
		// comes back immediately, not the past-agenda one and not a lock wait.
		// Fails when: the early signed-in check is removed: the removal then gives the
		// past-agenda refusal (the early past-agenda check is next), and if that is
		// gone too it waits for the merge lock and gives up after its 5 s lock timeout.
		const leaver = await seedLeaver();
		await testDb
			.update(people)
			.set({ userId: club.memberUserId })
			.where(eq(people.id, extraPeople[0] ?? ""));
		await holdSlot(await seedMeeting("completed", -7), leaver);
		const holder = await openBlockingTx(async (tx) => {
			await lockMembershipForMerge(tx, leaver);
			await tx
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, leaver))
				.for("update");
		});
		try {
			const outcome = remove(leaver).then(
				() => null,
				(e: unknown) => e,
			);
			expect(await settlesWithin(outcome, 1500)).toBe(true);
			expect((await outcome) as Error).toHaveProperty(
				"message",
				"That member is a signed-in account and can't be removed.",
			);
		} finally {
			await holder.commit();
		}
		expect(await memberRowExists(leaver)).toBe(true);
	});

	it("covers every ON DELETE SET NULL key to members.id: checked or deliberately not", async () => {
		// The checked list is hand-kept; this reads the database so a new table that
		// names a member and nulls on delete cannot be forgotten silently. A key
		// here must be in `PAST_AGENDA_MEMBER_KEYS` or `PAST_AGENDA_TIME_WINDOW_KEYS` (blocks removal) or in
		// CONSIDERED_NOT_BLOCKING below with a reason.
		const { PAST_AGENDA_MEMBER_KEYS, PAST_AGENDA_TIME_WINDOW_KEYS } =
			await import("#/server/members-logic");
		const res = await testDb.execute(sql`
			select cl.relname as "table", a.attname as "column"
			from pg_constraint c
			join pg_class cl on cl.oid = c.conrelid
			join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
			where c.contype = 'f'
			  and c.confrelid = 'public.members'::regclass
			  and c.confdeltype = 'n'
			order by 1, 2`);
		const inDb = (res.rows as { table: string; column: string }[]).map(
			(r) => `${r.table}.${r.column}`,
		);
		const checked = [
			...PAST_AGENDA_MEMBER_KEYS,
			...PAST_AGENDA_TIME_WINDOW_KEYS,
		].map((k) => `${getTableName(k.table)}.${k.memberColumn.name}`);
		const considered = Object.keys(CONSIDERED_NOT_BLOCKING);
		const unaccounted = inDb.filter(
			(k) => !checked.includes(k) && !considered.includes(k),
		);
		expect(unaccounted).toEqual([]);
		// And neither list names a key the database no longer has.
		expect(checked.filter((k) => !inDb.includes(k))).toEqual([]);
		expect(considered.filter((k) => !inDb.includes(k))).toEqual([]);
	});
});

/** Keys to `members.id` that null on delete and deliberately do NOT block a
 *  removal, each with the reason. A key moves to `PAST_AGENDA_MEMBER_KEYS` when it
 *  prints a name on an agenda. */
const CONSIDERED_NOT_BLOCKING: Record<string, string> = {
	"activity_log.actor_member_id": "audit trail, not on an agenda",
	"guest_invites.invited_by_member_id": "invite provenance, not on an agenda",
	"guests.converted_membership_id":
		"the guest's own record points at who they became, not on an agenda",
	"guests.introduced_by_member_id":
		"shown on the guest record only, not on an agenda",
	"meeting_candidate_disqualifications.disqualified_by_member_id":
		"ballot audit, not on an agenda (#1189 brief: votes do not block)",
	"meeting_timings.recorded_by_member_id":
		"who keyed the timing in; the speaker's name is the slot's, not on an agenda",
	"meeting_vote_sessions.opened_by_member_id":
		"#1189 brief: vote sessions print no name on an agenda",
	"meeting_votes.candidate_member_id":
		"#1189 brief: votes print no name on an agenda",
	"meeting_votes.voter_member_id":
		"#1189 brief: votes print no name on an agenda",
	"mentorships.created_by_member_id":
		"provenance of a mentor pair, not on an agenda",
	"project_completion_marks.marked_by_member_id":
		"#1189 brief: project marks print no name on an agenda",
};

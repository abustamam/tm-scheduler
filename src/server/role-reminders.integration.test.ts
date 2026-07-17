/**
 * DB-backed tests for the #272 role-assignment reminder PRODUCER: scan upcoming
 * scheduled meetings, enqueue one `notifications` row per slot holder at the
 * club's lead time, honoring #274's club enable + member opt-out, idempotently,
 * and never firing a reminder whose assignment went stale (re-validated at send
 * time by the #271 poller).
 *
 * Test-isolation notes (this suite shares `tm_test` with other integration
 * files running in PARALLEL, and the producer + poller are GLOBAL over all
 * clubs):
 *  - Enqueue assertions are scoped to THIS club's unique `slotId` (never global
 *    result counts), so another file's concurrently-seeded slots can't perturb
 *    them. The producer isolates each club's insert, so another file deleting a
 *    scanned club mid-pass can't abort ours.
 *  - The send-side tests drive the global `processDueNotifications`. They use an
 *    isolated clock window kept STRICTLY BELOW the #271 delivery suite's fixed
 *    2026-07-01 clock, so our sweep provably never selects (and steals) a #271
 *    row. Our own row could still be swept by #271, so we assert on the row's
 *    terminal STATE (which is identical no matter which sweeper finalizes it),
 *    never on our local mock's call count.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/role-reminders.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	guests,
	meetings,
	members,
	notifications,
	people,
	roleSlots,
	user,
} from "#/db/schema";
import type { SendEmailParams } from "#/lib/email";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { produceRoleReminders, ROLE_REMINDER_TYPE } = await import(
	"./role-reminders-logic"
);
const { processDueNotifications, isRoleReminderStale } = await import(
	"./notifications-logic"
);

const DAY_MS = 24 * 60 * 60 * 1000;

// Isolated clock window for the send-side tests, kept strictly BELOW the #271
// suite's fixed 2026-07-01 clock (see the header). meeting − 3d = the default
// lead time, so SEND_NOW is just past this row's send_at yet well before any
// #271 row's send_at.
const SEND_MEETING_AT = new Date("2026-06-15T18:00:00.000Z");
const SEND_PRODUCE_NOW = new Date("2026-06-01T00:00:00.000Z"); // < meeting ⇒ upcoming
const SEND_NOW = new Date("2026-06-13T00:00:00.000Z"); // ≥ send_at, < 2026-07-01

/** A resolving email transport that records the params it was called with. */
function okSender() {
	return vi
		.fn<(params: SendEmailParams) => Promise<void>>()
		.mockResolvedValue();
}

describe.skipIf(!hasTestDb)("role-reminder producer (#272)", () => {
	let club: SeededClub;
	let extraUserIds: string[];
	let memberEmail: string;
	let scheduledAt: Date;

	beforeEach(async () => {
		club = await seedClub();
		// Role reminders are opt-in per club (default off — soft launch), so enable
		// this test club to give the producer's happy-path cases an enabled baseline.
		// The "disabled" case below overrides it back to false.
		await testDb
			.update(clubs)
			.set({ reminderEnabled: true })
			.where(eq(clubs.id, club.clubId));
		extraUserIds = [];
		memberEmail = `member-${club.memberUserId}@test.example`;
		const [m] = await testDb
			.select({ scheduledAt: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.id, club.meetingId))
			.limit(1);
		scheduledAt = m.scheduledAt;
	});

	afterEach(async () => {
		await cleanup(club.clubId, [
			club.adminUserId,
			club.memberUserId,
			...extraUserIds,
		]);
		vi.restoreAllMocks();
	});

	// --- helpers -------------------------------------------------------------

	/** Put the seeded slot in a held state for the seeded (linked) member. */
	async function holdSeededSlot(status: "claimed" | "confirmed" = "claimed") {
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: club.memberId,
				assignedGuestId: null,
				status,
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, club.slotId));
	}

	/** Add a second club member with a linked sign-in account. */
	async function addLinkedMember(name: string) {
		const userId = randomUUID();
		const email = `${name.toLowerCase().replace(/\s+/g, "-")}-${userId}@test.example`;
		await testDb
			.insert(user)
			.values({ id: userId, name, email, emailVerified: true });
		extraUserIds.push(userId);
		const personId = await seedPerson({ name, email, userId });
		const [m] = await testDb
			.insert(members)
			.values({ clubId: club.clubId, personId, name, email })
			.returning({ id: members.id });
		return { userId, personId, memberId: m.id };
	}

	/** Reminders for THIS club's seeded slot (isolated from other files' rows). */
	async function listReminders(slotId: string = club.slotId) {
		return testDb
			.select()
			.from(notifications)
			.where(eq(notifications.slotId, slotId));
	}

	/** Move the seeded meeting into the isolated send-side clock window. */
	async function moveMeetingToSendWindow() {
		await testDb
			.update(meetings)
			.set({ scheduledAt: SEND_MEETING_AT })
			.where(eq(meetings.id, club.meetingId));
	}

	// --- enqueue -------------------------------------------------------------

	it("enqueues one email reminder for a held claimed slot", async () => {
		await holdSeededSlot("claimed");

		await produceRoleReminders();

		const rows = await listReminders();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			userId: club.memberUserId,
			slotId: club.slotId,
			assignedMemberId: club.memberId,
			type: ROLE_REMINDER_TYPE,
			channel: "email",
			sentAt: null,
		});
		// Default lead time is 3 days before the meeting.
		expect(rows[0].sendAt.getTime()).toBe(scheduledAt.getTime() - 3 * DAY_MS);
	});

	it("also enqueues for a confirmed slot", async () => {
		await holdSeededSlot("confirmed");

		await produceRoleReminders();

		expect(await listReminders()).toHaveLength(1);
	});

	it("uses the club's configured lead time for send_at", async () => {
		await holdSeededSlot();
		await testDb
			.update(clubs)
			.set({ reminderLeadTimeDays: 7 })
			.where(eq(clubs.id, club.clubId));

		await produceRoleReminders();

		const [row] = await listReminders();
		expect(row.sendAt.getTime()).toBe(scheduledAt.getTime() - 7 * DAY_MS);
	});

	it("skips enqueue entirely when the club has reminders disabled", async () => {
		await holdSeededSlot();
		await testDb
			.update(clubs)
			.set({ reminderEnabled: false })
			.where(eq(clubs.id, club.clubId));

		await produceRoleReminders();

		expect(await listReminders()).toHaveLength(0);
	});

	it("skips a member who opted out of reminders (#274)", async () => {
		await holdSeededSlot();
		await testDb
			.update(people)
			.set({ reminderOptOut: true })
			.where(eq(people.id, club.personId));

		await produceRoleReminders();

		expect(await listReminders()).toHaveLength(0);
	});

	it("is idempotent: a second run creates no duplicate", async () => {
		await holdSeededSlot();

		await produceRoleReminders();
		await produceRoleReminders();

		expect(await listReminders()).toHaveLength(1);
	});

	// --- skip guests / unlinked / past / completed ---------------------------

	it("skips a slot held by a guest (no linked member)", async () => {
		const [guest] = await testDb
			.insert(guests)
			.values({ clubId: club.clubId, name: "Visitor" })
			.returning({ id: guests.id });
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: null,
				assignedGuestId: guest.id,
				status: "claimed",
			})
			.where(eq(roleSlots.id, club.slotId));

		await produceRoleReminders();

		expect(await listReminders()).toHaveLength(0);
	});

	it("skips a member with no linked sign-in account", async () => {
		const personId = await seedPerson({ name: "Unlinked", userId: null });
		const [m] = await testDb
			.insert(members)
			.values({ clubId: club.clubId, personId, name: "Unlinked" })
			.returning({ id: members.id });
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: m.id, status: "claimed", claimedAt: new Date() })
			.where(eq(roleSlots.id, club.slotId));

		await produceRoleReminders();

		expect(await listReminders()).toHaveLength(0);
	});

	it("skips a completed (locked) meeting", async () => {
		await holdSeededSlot();
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));

		await produceRoleReminders();

		expect(await listReminders()).toHaveLength(0);
	});

	it("skips a past meeting", async () => {
		await holdSeededSlot();
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - DAY_MS) })
			.where(eq(meetings.id, club.meetingId));

		await produceRoleReminders();

		expect(await listReminders()).toHaveLength(0);
	});

	// --- end-to-end with the #271 poller (isolated clock window) --------------

	it("produces a row the poller then delivers (reaches a sent terminal state)", async () => {
		await moveMeetingToSendWindow();
		await holdSeededSlot();
		await produceRoleReminders({ now: () => SEND_PRODUCE_NOW });

		const sendEmail = okSender();
		await processDueNotifications({ sendEmail, now: () => SEND_NOW });

		// Delivered, not suppressed/stale — a terminal state any sweeper produces
		// identically for this (valid) row.
		const [row] = await listReminders();
		expect(row.sentAt).toBeInstanceOf(Date);
		expect(row.lastError).toBeNull();
	});

	// --- stale-assignment safety (the AC that makes this PR safe) -------------

	it("does NOT send a reminder for a slot reassigned before send time", async () => {
		await moveMeetingToSendWindow();
		await holdSeededSlot();
		await produceRoleReminders({ now: () => SEND_PRODUCE_NOW });

		// Reassign the slot to a different member after the reminder was enqueued.
		const memberB = await addLinkedMember("Member B");
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: memberB.memberId, status: "claimed" })
			.where(eq(roleSlots.id, club.slotId));

		const sendEmail = okSender();
		await processDueNotifications({ sendEmail, now: () => SEND_NOW });

		// The original assignee is never mailed; the row is finalized as stale.
		expect(sendEmail.mock.calls.some((c) => c[0].to === memberEmail)).toBe(
			false,
		);
		const rows = await listReminders();
		const original = rows.find((r) => r.assignedMemberId === club.memberId);
		expect(original?.sentAt).toBeInstanceOf(Date); // terminal, never retried
		expect(original?.lastError).toContain("role assignment changed");
	});

	it("does NOT send a reminder for a slot released before send time", async () => {
		await moveMeetingToSendWindow();
		await holdSeededSlot();
		await produceRoleReminders({ now: () => SEND_PRODUCE_NOW });

		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: null, assignedGuestId: null, status: "open" })
			.where(eq(roleSlots.id, club.slotId));

		const sendEmail = okSender();
		await processDueNotifications({ sendEmail, now: () => SEND_NOW });

		expect(sendEmail.mock.calls.some((c) => c[0].to === memberEmail)).toBe(
			false,
		);
		const [row] = await listReminders();
		expect(row.sentAt).toBeInstanceOf(Date);
		expect(row.lastError).toContain("role assignment changed");
	});

	it("does NOT send when the meeting is cancelled before send time", async () => {
		await moveMeetingToSendWindow();
		await holdSeededSlot();
		await produceRoleReminders({ now: () => SEND_PRODUCE_NOW });

		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, club.meetingId));

		const sendEmail = okSender();
		await processDueNotifications({ sendEmail, now: () => SEND_NOW });

		expect(sendEmail.mock.calls.some((c) => c[0].to === memberEmail)).toBe(
			false,
		);
		const [row] = await listReminders();
		expect(row.sentAt).toBeInstanceOf(Date);
		expect(row.lastError).toContain("role assignment changed");
	});

	it("enqueues a fresh reminder for the NEW holder after a reassignment", async () => {
		await holdSeededSlot();
		await produceRoleReminders();

		const memberB = await addLinkedMember("Member B");
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: memberB.memberId, status: "claimed" })
			.where(eq(roleSlots.id, club.slotId));

		await produceRoleReminders();

		// New (slot, member) pair ⇒ a second row; the original is untouched.
		const rows = await listReminders();
		expect(rows).toHaveLength(2);
		expect(rows.some((r) => r.assignedMemberId === memberB.memberId)).toBe(
			true,
		);
		expect(rows.some((r) => r.assignedMemberId === club.memberId)).toBe(true);
	});
});

// Pure decision matrix for the send-time staleness re-validation (#272). No DB —
// deterministic, so it documents exactly when the poller suppresses a reminder.
describe("isRoleReminderStale", () => {
	const base = {
		id: "n1",
		type: "role_reminder",
		channel: "email",
		attempts: 0,
		personId: "p1",
		reminderOptOut: false,
		recipientEmail: "a@b.c",
		recipientName: "A",
		roleName: "Timer",
		clubName: "Club",
		meetingScheduledAt: new Date(),
		expectedAssignedMemberId: "m1",
		currentAssignedMemberId: "m1",
		slotStatus: "claimed",
		meetingStatus: "scheduled",
	};

	it("is not stale when the slot is still held by the same member", () => {
		expect(isRoleReminderStale({ ...base })).toBe(false);
		expect(isRoleReminderStale({ ...base, slotStatus: "confirmed" })).toBe(
			false,
		);
	});

	it("never re-validates a non-role row (null member reference)", () => {
		// A #271 delivery-foundation row: no assignee recorded ⇒ always current.
		expect(
			isRoleReminderStale({
				...base,
				expectedAssignedMemberId: null,
				currentAssignedMemberId: null,
				slotStatus: "open",
			}),
		).toBe(false);
	});

	it("is stale when reassigned, released, or the meeting is not scheduled", () => {
		expect(
			isRoleReminderStale({ ...base, currentAssignedMemberId: "m2" }),
		).toBe(true); // reassigned
		expect(
			isRoleReminderStale({
				...base,
				currentAssignedMemberId: null,
				slotStatus: "open",
			}),
		).toBe(true); // released
		expect(isRoleReminderStale({ ...base, meetingStatus: "completed" })).toBe(
			true,
		);
		expect(isRoleReminderStale({ ...base, meetingStatus: "cancelled" })).toBe(
			true,
		);
	});
});

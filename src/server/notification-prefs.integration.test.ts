/**
 * DB-backed tests for the #274 reminder control layer: club reminder settings
 * (defaults + persistence), the per-Person member opt-out (round-trip + the
 * no-auth unsubscribe-token flip, rejecting forgeries), the reader helpers the
 * #272 producer consumes (listOptedOutPersonIds / filterRemindableMembers), and
 * the poller honoring opt-out at send time + carrying the unsubscribe link.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/notification-prefs.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications, people } from "#/db/schema";
import type { SendEmailParams } from "#/lib/email";
import {
	createUnsubscribeToken,
	verifyUnsubscribeToken,
} from "#/lib/unsubscribe-token";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	DEFAULT_CLUB_REMINDER_SETTINGS,
	applyClubReminderSettings,
	filterRemindableMembers,
	getClubReminderSettings,
	getReminderOptOutForUser,
	listOptedOutPersonIds,
	setPersonReminderOptOut,
	setReminderOptOutForUser,
} = await import("./notification-prefs-logic");

const { enqueueNotification, processDueNotifications } = await import(
	"./notifications-logic"
);

function okSender() {
	return vi
		.fn<(params: SendEmailParams) => Promise<void>>()
		.mockResolvedValue();
}

describe.skipIf(!hasTestDb)("reminder control layer (#274)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		vi.restoreAllMocks();
	});

	// --- Club-level settings -------------------------------------------------

	it("getClubReminderSettings returns the defaults (reminders off) for a fresh club", async () => {
		const settings = await getClubReminderSettings(club.clubId);
		expect(settings).toEqual({ enabled: false, leadTimeDays: 3 });
		expect(settings).toEqual(DEFAULT_CLUB_REMINDER_SETTINGS);
	});

	it("applyClubReminderSettings persists and getClubReminderSettings reads it back", async () => {
		await applyClubReminderSettings({
			clubId: club.clubId,
			enabled: false,
			leadTimeDays: 7,
		});
		expect(await getClubReminderSettings(club.clubId)).toEqual({
			enabled: false,
			leadTimeDays: 7,
		});
	});

	it("getClubReminderSettings falls back to defaults for a missing club", async () => {
		expect(await getClubReminderSettings(randomUUID())).toEqual(
			DEFAULT_CLUB_REMINDER_SETTINGS,
		);
	});

	// --- Member-level opt-out ------------------------------------------------

	it("member opt-out round-trips per user (default opted-in)", async () => {
		expect(await getReminderOptOutForUser(club.memberUserId)).toBe(false);

		const on = await setReminderOptOutForUser(club.memberUserId, true);
		expect(on).toEqual({ ok: true, updated: true });
		expect(await getReminderOptOutForUser(club.memberUserId)).toBe(true);

		await setReminderOptOutForUser(club.memberUserId, false);
		expect(await getReminderOptOutForUser(club.memberUserId)).toBe(false);
	});

	it("setReminderOptOutForUser is a graceful no-op for a user with no linked person", async () => {
		const res = await setReminderOptOutForUser(randomUUID(), true);
		expect(res).toEqual({ ok: true, updated: false });
	});

	// --- No-auth unsubscribe token -------------------------------------------

	it("a valid unsubscribe token flips the person's opt-out to on", async () => {
		const token = createUnsubscribeToken(club.personId);
		const personId = verifyUnsubscribeToken(token);
		expect(personId).toBe(club.personId);

		const flip = await setPersonReminderOptOut(personId as string, true);
		expect(flip).toEqual({ ok: true, updated: true });

		const [row] = await testDb
			.select({ optOut: people.reminderOptOut })
			.from(people)
			.where(eq(people.id, club.personId));
		expect(row.optOut).toBe(true);
	});

	it("a forged token verifies to null, so it can never flip a preference", async () => {
		const token = createUnsubscribeToken(club.personId);
		const sig = token.slice(token.lastIndexOf(".") + 1);
		// Keep the real signature but point it at a different person.
		const forged = `${randomUUID()}.${sig}`;
		expect(verifyUnsubscribeToken(forged)).toBeNull();

		// The member's preference is untouched (still opted-in).
		expect(await getReminderOptOutForUser(club.memberUserId)).toBe(false);
	});

	// --- Producer (#272) reader helpers --------------------------------------

	it("listOptedOutPersonIds returns only the opted-out subset", async () => {
		const inA = await seedPerson({ name: "Opted In A" });
		const inB = await seedPerson({ name: "Opted In B" });
		try {
			await setPersonReminderOptOut(club.personId, true);

			const optedOut = await listOptedOutPersonIds([club.personId, inA, inB]);
			expect(optedOut.has(club.personId)).toBe(true);
			expect(optedOut.has(inA)).toBe(false);
			expect(optedOut.has(inB)).toBe(false);
			expect(optedOut.size).toBe(1);

			// Empty input short-circuits to an empty set.
			expect(await listOptedOutPersonIds([])).toEqual(new Set());
		} finally {
			await testDb.delete(people).where(inArray(people.id, [inA, inB]));
		}
	});

	it("filterRemindableMembers drops opted-out members, preserving the rest and their fields", async () => {
		const inA = await seedPerson({ name: "Opted In A" });
		try {
			await setPersonReminderOptOut(club.personId, true);
			const members = [
				{ personId: club.personId, memberId: "m1" },
				{ personId: inA, memberId: "m2" },
			];
			const remindable = await filterRemindableMembers(members);
			expect(remindable).toEqual([{ personId: inA, memberId: "m2" }]);
		} finally {
			await testDb.delete(people).where(eq(people.id, inA));
		}
	});

	// --- Poller honors opt-out + carries the unsubscribe link (send time) ----

	it("processDueNotifications suppresses a due reminder for an opted-out recipient", async () => {
		await setPersonReminderOptOut(club.personId, true);
		const id = await enqueueNotification({
			userId: club.memberUserId,
			slotId: club.slotId,
			type: "role_reminder",
			sendAt: new Date(Date.now() - 60_000),
		});

		const sendEmail = okSender();
		const result = await processDueNotifications({
			sendEmail,
			now: () => new Date(),
		});

		// Isolation-safe: processDueNotifications is GLOBAL, so under the parallel
		// suite it can also sweep a concurrent test's due row (it runs with real
		// `now()`, above the other reminder suites' isolated clock windows). Assert on
		// THIS row's terminal state + a lower-bound suppression count — not the shared
		// sender mock or exact global counts.
		expect(result.suppressed).toBeGreaterThanOrEqual(1);

		const [row] = await testDb
			.select()
			.from(notifications)
			.where(eq(notifications.id, id));
		expect(row.sentAt).toBeInstanceOf(Date); // finalized — never retried
		expect(row.lastError).toContain("opted out"); // suppressed, not delivered
	});

	it("a delivered reminder email carries a valid no-auth unsubscribe link", async () => {
		await enqueueNotification({
			userId: club.memberUserId,
			slotId: club.slotId,
			type: "role_reminder",
			sendAt: new Date(Date.now() - 60_000),
		});

		const sendEmail = okSender();
		const result = await processDueNotifications({
			sendEmail,
			now: () => new Date(),
		});
		expect(result.sent).toBe(1);

		const params = sendEmail.mock.calls[0][0];
		expect(params.text).toContain("/unsubscribe?token=");
		expect(params.html).toContain("/unsubscribe?token=");

		// The embedded token verifies back to the recipient's Person.
		const match = params.text.match(/\/unsubscribe\?token=(\S+)/);
		expect(match).not.toBeNull();
		const token = decodeURIComponent((match as RegExpMatchArray)[1]);
		expect(verifyUnsubscribeToken(token)).toBe(club.personId);
	});
});

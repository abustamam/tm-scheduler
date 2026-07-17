/**
 * DB-backed tests for the #271 reminder delivery foundation: select DUE
 * `notifications` rows, deliver each exactly once through an injected transport,
 * mark `sent_at` on success / leave unsent (bounded retry) on failure, and route
 * by `channel`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/notifications.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications } from "#/db/schema";
import type { SendEmailParams } from "#/lib/email";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	MAX_SEND_ATTEMPTS,
	RETRY_BACKOFF_MS,
	enqueueNotification,
	processDueNotifications,
} = await import("./notifications-logic");

const NOW = new Date("2026-07-01T12:00:00Z");

/** A resolving email transport that records the params it was called with. */
function okSender() {
	return vi
		.fn<(params: SendEmailParams) => Promise<void>>()
		.mockResolvedValue();
}

/** A transport that always rejects (simulates a Resend/network failure). */
function failingSender(message = "boom") {
	return vi
		.fn<(params: SendEmailParams) => Promise<void>>()
		.mockRejectedValue(new Error(message));
}

async function readNotification(id: string) {
	const [row] = await testDb
		.select()
		.from(notifications)
		.where(eq(notifications.id, id))
		.limit(1);
	return row;
}

describe.skipIf(!hasTestDb)("reminder delivery foundation (#271)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		vi.restoreAllMocks();
	});

	it("selects and delivers a due row: sends email + sets sent_at", async () => {
		const id = await enqueueNotification({
			userId: club.memberUserId,
			slotId: club.slotId,
			type: "role_reminder",
			sendAt: new Date(NOW.getTime() - 60_000), // due (1 min ago)
		});

		const sendEmail = okSender();
		const result = await processDueNotifications({
			sendEmail,
			now: () => NOW,
		});

		expect(result).toMatchObject({ due: 1, sent: 1, failed: 0, skipped: 0 });
		expect(sendEmail).toHaveBeenCalledTimes(1);

		const params = sendEmail.mock.calls[0][0];
		expect(params.to).toBe(`member-${club.memberUserId}@test.example`);
		expect(params.subject).toContain("Timer"); // the seeded role name
		expect(params.subject).toContain("Test Club");
		expect(params.html).toContain("Timer");
		expect(params.text).toContain("Timer");

		const row = await readNotification(id);
		expect(row.sentAt).toBeInstanceOf(Date);
		expect(row.attempts).toBe(1);
		expect(row.lastError).toBeNull();
	});

	it("does not select a row whose send_at is in the future", async () => {
		await enqueueNotification({
			userId: club.memberUserId,
			slotId: club.slotId,
			type: "role_reminder",
			sendAt: new Date(NOW.getTime() + 60 * 60_000), // 1h out
		});

		const sendEmail = okSender();
		const result = await processDueNotifications({ sendEmail, now: () => NOW });

		expect(result.due).toBe(0);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("failure leaves the row unsent for retry, records the error, bumps attempts", async () => {
		const id = await enqueueNotification({
			userId: club.memberUserId,
			slotId: club.slotId,
			type: "role_reminder",
			sendAt: new Date(NOW.getTime() - 60_000),
		});

		const sendEmail = failingSender("resend exploded");
		const result = await processDueNotifications({ sendEmail, now: () => NOW });

		expect(result).toMatchObject({ due: 1, sent: 0, failed: 1 });

		const row = await readNotification(id);
		expect(row.sentAt).toBeNull(); // still unsent
		expect(row.attempts).toBe(1); // one attempt spent
		expect(row.lastError).toContain("resend exploded");
	});

	it("does NOT double-send under two concurrent ticks (at-most-once claim)", async () => {
		const id = await enqueueNotification({
			userId: club.memberUserId,
			slotId: club.slotId,
			type: "role_reminder",
			sendAt: new Date(NOW.getTime() - 60_000),
		});

		// One shared transport across both ticks — only the claim winner may call it.
		const sendEmail = okSender();
		const deps = { sendEmail, now: () => NOW };

		const [a, b] = await Promise.all([
			processDueNotifications(deps),
			processDueNotifications(deps),
		]);

		// Exactly one delivery across both ticks.
		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(a.sent + b.sent).toBe(1);

		const row = await readNotification(id);
		expect(row.sentAt).toBeInstanceOf(Date);
		expect(row.attempts).toBe(1); // claimed once, not twice
	});

	it("routes by channel: a non-email channel is skipped, not sent", async () => {
		const id = await enqueueNotification({
			userId: club.memberUserId,
			slotId: club.slotId,
			type: "role_reminder",
			channel: "push",
			sendAt: new Date(NOW.getTime() - 60_000),
		});

		const sendEmail = okSender();
		const result = await processDueNotifications({ sendEmail, now: () => NOW });

		expect(result).toMatchObject({ due: 1, sent: 0, skipped: 1 });
		expect(sendEmail).not.toHaveBeenCalled();

		const row = await readNotification(id);
		expect(row.sentAt).toBeNull();
		expect(row.lastError).toContain("unsupported channel: push");
	});

	it("holds a just-failed row out of the due set until the retry backoff passes", async () => {
		const id = await enqueueNotification({
			userId: club.memberUserId,
			slotId: club.slotId,
			type: "role_reminder",
			sendAt: new Date(NOW.getTime() - 60_000),
		});

		// First tick fails.
		await processDueNotifications({
			sendEmail: failingSender(),
			now: () => NOW,
		});

		// Same instant: within backoff → not retried yet.
		const soon = okSender();
		const within = await processDueNotifications({
			sendEmail: soon,
			now: () => NOW,
		});
		expect(within.due).toBe(0);
		expect(soon).not.toHaveBeenCalled();

		// Past the backoff → eligible again, and this time it succeeds.
		const later = okSender();
		const afterBackoff = await processDueNotifications({
			sendEmail: later,
			now: () => new Date(NOW.getTime() + RETRY_BACKOFF_MS + 60_000),
		});
		expect(afterBackoff.sent).toBe(1);
		expect(later).toHaveBeenCalledTimes(1);

		const row = await readNotification(id);
		expect(row.sentAt).toBeInstanceOf(Date);
		expect(row.attempts).toBe(2); // failed once, then delivered
	});

	it("abandons a row once it exhausts the retry budget", async () => {
		const id = await enqueueNotification({
			userId: club.memberUserId,
			slotId: club.slotId,
			type: "role_reminder",
			sendAt: new Date(NOW.getTime() - 60_000),
		});
		// Simulate having burned the whole budget already.
		await testDb
			.update(notifications)
			.set({ attempts: MAX_SEND_ATTEMPTS })
			.where(eq(notifications.id, id));

		const sendEmail = okSender();
		const result = await processDueNotifications({ sendEmail, now: () => NOW });

		expect(result.due).toBe(0);
		expect(sendEmail).not.toHaveBeenCalled();
	});
});

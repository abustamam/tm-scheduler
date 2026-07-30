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
import { user } from "#/db/auth-schema";
import { members, notifications, people } from "#/db/schema";
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

	// Every poll scopes to THIS club so a concurrently-running poller test file
	// (shared tm_test DB, global poller) can't claim our due notifications (#298).
	const poll = (deps: Parameters<typeof processDueNotifications>[0]) =>
		processDueNotifications(deps, undefined, club.clubId);

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

	// --- Duplicate Persons on one account (#437) ------------------------------
	//
	// `people.user_id` is not unique, and the #272 producer suppresses per-Person
	// (listOptedOutPersonIds, keyed on members.person_id). So the /me toggle can
	// only honestly say "opted out" when every MAILABLE linked Person is — one
	// arbitrary row could report either answer wrongly, and a Person holding no
	// roster membership can never be mailed at all, so it does not get a vote.

	/**
	 * A second Person on the same account — the duplicate #329 has not merged.
	 *
	 * It carries its OWN roster membership, which is what makes it mailable: the
	 * #272 producer reaches recipients through roleSlots→members→people, so a
	 * membership-less duplicate could never receive a reminder and deliberately
	 * does not count toward the toggle (see the membership-less test below).
	 */
	async function addDuplicatePerson(): Promise<string> {
		const personId = await seedPerson({
			name: "Duplicate Member",
			userId: club.memberUserId,
		});
		await testDb.insert(members).values({
			clubId: club.clubId,
			personId,
			name: "Duplicate Member",
			clubRole: "member",
			status: "active",
		});
		return personId;
	}

	it("reports opted-in while ANY linked Person still receives reminders", async () => {
		// Both writers now converge every row on the account, so the split state
		// is reached the one way that remains: the account opts out, and a NEW
		// duplicate Person is minted afterwards (create-club / roster-paste mints
		// a fresh Person per club, #329) carrying the opted-IN column default.
		await setReminderOptOutForUser(club.memberUserId, true);
		const dupe = await addDuplicatePerson();
		try {
			expect(await listOptedOutPersonIds([club.personId, dupe])).toEqual(
				new Set([club.personId]),
			);
			// Reminders are genuinely still being sent via the newcomer, so
			// "opted out" would be a lie on a preference screen.
			expect(await getReminderOptOutForUser(club.memberUserId)).toBe(false);
		} finally {
			await testDb.delete(people).where(eq(people.id, dupe));
		}
	});

	// The gap #472 reported: reminder mail is addressed per-ACCOUNT
	// (selectDueNotifications joins `user` via notifications.user_id), so two
	// linked Persons mail the same inbox. Flipping one row let mail keep
	// arriving at the address that had just asked it to stop.
	it("one-click unsubscribe suppresses EVERY Person on the account", async () => {
		const dupe = await addDuplicatePerson();
		try {
			// Exactly what the no-auth route does with a verified signed token.
			const token = createUnsubscribeToken(club.personId);
			const personId = verifyUnsubscribeToken(token) as string;
			await setPersonReminderOptOut(personId, true);

			expect(await listOptedOutPersonIds([club.personId, dupe])).toEqual(
				new Set([club.personId, dupe]),
			);
			expect(await getReminderOptOutForUser(club.memberUserId)).toBe(true);
		} finally {
			await testDb.delete(people).where(eq(people.id, dupe));
		}
	});

	// ...but a Person that never signed in has no account to converge, and must
	// not drag along every other unlinked roster Person in the database.
	it("unsubscribe for an unlinked roster Person flips only that row", async () => {
		const loner = await seedPerson({ name: "Never Signed In" });
		const bystander = await seedPerson({ name: "Unrelated Roster Person" });
		try {
			await setPersonReminderOptOut(loner, true);
			expect(await listOptedOutPersonIds([loner, bystander])).toEqual(
				new Set([loner]),
			);
		} finally {
			await testDb.delete(people).where(inArray(people.id, [loner, bystander]));
		}
	});

	it("reports opted-out once every linked Person is opted out", async () => {
		const dupe = await addDuplicatePerson();
		try {
			// One use of the /me toggle converges every row — that is why the
			// writer fans out while the reader aggregates.
			await setReminderOptOutForUser(club.memberUserId, true);

			expect(await listOptedOutPersonIds([club.personId, dupe])).toEqual(
				new Set([club.personId, dupe]),
			);
			expect(await getReminderOptOutForUser(club.memberUserId)).toBe(true);

			// ...and toggling back releases both, not just one.
			await setReminderOptOutForUser(club.memberUserId, false);
			expect(await listOptedOutPersonIds([club.personId, dupe])).toEqual(
				new Set(),
			);
			expect(await getReminderOptOutForUser(club.memberUserId)).toBe(false);
		} finally {
			await testDb.delete(people).where(eq(people.id, dupe));
		}
	});

	// The two tests above assert the CONTRACT but cannot, on their own, catch a
	// reader that takes one arbitrary row: when the answer is false, at least one
	// row is false, so an arbitrary pick is often right by accident. Worse, an
	// UPDATE relocates a row to the end of the heap, so an unordered LIMIT 1
	// reliably returns the row that was NOT just flipped — which is the opted-in
	// one, making a broken reader agree with the fixture every time.
	//
	// This fixture removes that luck: the opted-out Person is written FIRST and
	// never updated, so it is the row an unordered scan hands back.
	it("reports opted-in even when the FIRST linked Person is the opted-out one", async () => {
		const soloUserId = randomUUID();
		await testDb.insert(user).values({
			id: soloUserId,
			name: "Split Prefs",
			email: `${soloUserId}@test.example`,
		});
		// Inserted (not updated) with the flag already set, so the row keeps its
		// original heap position: insert order is the scan order.
		const [first] = await testDb
			.insert(people)
			.values({
				name: "Opted Out (first)",
				email: `${randomUUID()}@test.example`,
				userId: soloUserId,
				reminderOptOut: true,
			})
			.returning({ id: people.id });
		const [second] = await testDb
			.insert(people)
			.values({
				name: "Opted In (second)",
				email: `${randomUUID()}@test.example`,
				userId: soloUserId,
			})
			.returning({ id: people.id });
		const optedOut = first.id;
		const stillOptedIn = second.id;
		try {
			expect(await listOptedOutPersonIds([optedOut, stillOptedIn])).toEqual(
				new Set([optedOut]),
			);
			// One row says "suppressed", the account is not.
			expect(await getReminderOptOutForUser(soloUserId)).toBe(false);
		} finally {
			await testDb
				.delete(people)
				.where(inArray(people.id, [optedOut, stillOptedIn]));
			await testDb.delete(user).where(eq(user.id, soloUserId));
		}
	});

	// A linked Person holding no roster membership can never be mailed — the
	// producer builds recipients through roleSlots→members→people. Counting it
	// let one newly-linked orphan flip the screen back to "reminders on" with no
	// change in what arrives. This is the dominant real shape: eight accounts in
	// the dev database carry 5-6 linked Persons of which exactly one is rostered.
	it("ignores membership-less Persons when deciding the toggle", async () => {
		const orphan = await seedPerson({
			name: "Linked But Unrostered",
			userId: club.memberUserId,
		});
		try {
			// The ROSTERED Person opts out; the orphan keeps the opted-in default.
			await setPersonReminderOptOut(club.personId, true);
			await testDb
				.update(people)
				.set({ reminderOptOut: false })
				.where(eq(people.id, orphan));

			// The orphan cannot receive anything, so it must not veto the answer.
			expect(await getReminderOptOutForUser(club.memberUserId)).toBe(true);
		} finally {
			await testDb.delete(people).where(eq(people.id, orphan));
		}
	});

	// ...but an account with NO rostered Person at all still has to be able to
	// work its own toggle, rather than reading a stuck value forever.
	it("an account with only membership-less Persons still round-trips", async () => {
		const soloUserId = randomUUID();
		await testDb.insert(user).values({
			id: soloUserId,
			name: "No Roster Yet",
			email: `${soloUserId}@test.example`,
		});
		const orphan = await seedPerson({
			name: "Unrostered",
			userId: soloUserId,
		});
		try {
			expect(await getReminderOptOutForUser(soloUserId)).toBe(false);
			await setReminderOptOutForUser(soloUserId, true);
			expect(await getReminderOptOutForUser(soloUserId)).toBe(true);
			await setReminderOptOutForUser(soloUserId, false);
			expect(await getReminderOptOutForUser(soloUserId)).toBe(false);
		} finally {
			await testDb.delete(people).where(eq(people.id, orphan));
			await testDb.delete(user).where(eq(user.id, soloUserId));
		}
	});

	it("a user with no linked Person reads as opted-in, not opted-out", async () => {
		// `every` over an empty set is vacuously true — the row count guard is
		// what keeps a person-less account from reading as suppressed.
		expect(await getReminderOptOutForUser(randomUUID())).toBe(false);
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
		const result = await poll({
			sendEmail,
			now: () => new Date(),
		});

		// Club-scoped poll (#298), so only this club's rows are swept — counts are
		// deterministic even under the parallel suite (no more global sweep).
		expect(result.suppressed).toBe(1);

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
		const result = await poll({
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

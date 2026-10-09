/**
 * DB-backed test for what is left of the minutes email after #903: the DEFAULT
 * recipient list the officer's draft starts from. GavelUp no longer sends the
 * minutes, so there is no send path to drive here — the draft is built
 * client-side (`#/lib/minutes-mailto`) and the attachment is the PDF route's
 * guest copy (`minutes-pdf-route.integration.test.ts`).
 *
 * `loadRecipients` runs for real against the seeded rows, through the port the
 * `getMinutesRecipients` server fn uses, with `#/db` pointed at the test db.
 * Every seeded club-scoped row cascades from the club in `cleanup`.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, meetingAttendance, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { createMinutesEmailPort } = await import("./minutes-email-port-logic");
const { resolveMinutesRecipients } = await import("./minutes-email-logic");

describe.skipIf(!hasTestDb)("minutes email default recipients (#903)", () => {
	let seeded: SeededClub;
	const run = randomUUID().slice(0, 8);

	beforeEach(async () => {
		seeded = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	async function addGuest(
		name: string,
		email: string | null,
		status: "present" | "absent",
	) {
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson({ clubId: seeded.clubId, name, email }, testDb),
			)
			.returning({ id: guests.id });
		if (!g) throw new Error("guest insert failed");
		await testDb.insert(meetingAttendance).values({
			meetingId: seeded.meetingId,
			guestId: g.id,
			status,
		});
	}

	it("is the active roster plus the guests marked present, split by email", async () => {
		const lapsedPerson = await seedPerson({
			name: `Lapsed ${run}`,
			email: `lapsed-${run}@test.example`,
		});
		await testDb.insert(members).values({
			clubId: seeded.clubId,
			personId: lapsedPerson,
			name: `Lapsed ${run}`,
			clubRole: "member",
			status: "inactive",
		});
		await addGuest(`Gwen ${run}`, `gwen-${run}@guest.example`, "present");
		await addGuest(`Nomail ${run}`, null, "present");
		await addGuest(`Absent ${run}`, `absent-${run}@guest.example`, "absent");

		const port = createMinutesEmailPort();
		const loaded = await port.loadRecipients(seeded.meetingId);
		const { recipients, skipped } = resolveMinutesRecipients(loaded);

		expect(recipients.map((r) => r.email)).toEqual([
			`admin-${seeded.adminUserId}@test.example`,
			`member-${seeded.memberUserId}@test.example`,
			`gwen-${run}@guest.example`,
		]);
		expect(skipped).toEqual([{ name: `Nomail ${run}` }]);
	});

	it("throws for a meeting that does not exist", async () => {
		await expect(
			createMinutesEmailPort().loadRecipients(randomUUID()),
		).rejects.toThrow("Meeting not found.");
	});
});

/**
 * The minutes email's default recipients and the guest book's unconfirmed note
 * (#1157). `loadRecipients` runs for real against seeded rows with `#/db`
 * pointed at the test database, as `minutes-email.integration.test.ts` does.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, meetingAttendance } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { createMinutesEmailPort } = await import("./minutes-email-port-logic");

describe.skipIf(!hasTestDb)(
	"minutes email recipients include a guest's book note (#1157)",
	() => {
		let seeded: SeededClub;
		const run = randomUUID().slice(0, 8);

		beforeEach(async () => {
			seeded = await seedClub();
		});
		afterEach(async () => {
			await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		});

		async function presentGuest(
			name: string,
			bookEmail: string | null,
			vouched: string | null = null,
		) {
			const [g] = await testDb
				.insert(guests)
				.values({
					...(await withGuestPerson(
						{ clubId: seeded.clubId, name, email: vouched },
						testDb,
					)),
					bookEmail,
				})
				.returning({ id: guests.id });
			if (!g) throw new Error("guest insert failed");
			await testDb.insert(meetingAttendance).values({
				meetingId: seeded.meetingId,
				guestId: g.id,
				status: "present",
			});
		}

		// protects=a present guest whose only address is guests.book_email is a draft recipient at that address, and a vouched address wins over a note;
		// fails_when=loadRecipients selects people.email alone, so a guest who signed the book silently drops out of the minutes draft;
		// no_claim=that anything is sent (GavelUp sends nothing, ADR-0028); the draft is the officer's to review.
		it("lists a present guest with only a book note, preferring a vouched address", async () => {
			await presentGuest(`Noted ${run}`, `note-${run}@guest.example`);
			await presentGuest(
				`Both ${run}`,
				`stale-${run}@guest.example`,
				`vouched-${run}@guest.example`,
			);
			await presentGuest(`Nothing ${run}`, null);

			const loaded = await createMinutesEmailPort().loadRecipients(
				seeded.meetingId,
			);

			expect(loaded.presentGuests).toEqual([
				{ name: `Both ${run}`, email: `vouched-${run}@guest.example` },
				{ name: `Noted ${run}`, email: `note-${run}@guest.example` },
				{ name: `Nothing ${run}`, email: null },
			]);
		});
	},
);

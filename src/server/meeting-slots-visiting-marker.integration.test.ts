/**
 * `loadMeetingSlots` flags a visiting Toastmaster, and only one (#1164).
 *
 * `assigneeIsVisitingToastmaster` is what turns "Name · Guest" into "Name (V)" on
 * the screen agenda, all four print layouts, the run sheet, the deck, the .pptx
 * and the next-meeting slide, so a wrong value here is wrong everywhere at once.
 * It is derived from the guest row's `kind`, never from a home club, and never
 * set for a member or an open slot.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadMeetingSlots } = await import("./meeting-slots-logic");

describe.skipIf(!hasTestDb)(
	"loadMeetingSlots visiting Toastmaster flag",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		const slotNow = async () =>
			(await loadMeetingSlots(seed.meetingId)).find(
				(s) => s.id === seed.slotId,
			);

		async function holdAsGuest(
			kind: "visitor" | "visiting_toastmaster",
			homeClub: string | null,
		) {
			const [guest] = await testDb
				.insert(guests)
				.values(
					await withGuestPerson(
						{
							clubId: seed.clubId,
							name: "Jane Doe",
							email: `jane-${randomUUID()}@example.test`,
							kind,
							homeClub,
						},
						testDb,
					),
				)
				.returning({ id: guests.id });
			if (!guest) throw new Error("guest insert failed");
			await testDb
				.update(roleSlots)
				.set({ assignedGuestId: guest.id, status: "claimed" })
				.where(eq(roleSlots.id, seed.slotId));
			return slotNow();
		}

		// protects=a slot held by a visiting Toastmaster guest is flagged, with or
		// without a home club on file;
		// fails_when=the flag is derived from the home club instead of the kind, or the
		// kind column is not read (so it is never true);
		// no_claim=how the flag renders: agenda-guest-marker.test.ts and the layout
		// tests pin that; this is the real join against Postgres.
		it("flags a visiting Toastmaster guest", async () => {
			for (const homeClub of ["Downtown TM", null]) {
				const slot = await holdAsGuest("visiting_toastmaster", homeClub);
				expect(slot?.assigneeIsGuest, String(homeClub)).toBe(true);
				expect(slot?.assigneeIsVisitingToastmaster, String(homeClub)).toBe(
					true,
				);
			}
		});

		// protects=a Visitor (even one with a leftover home club), a member and an open
		// slot are never flagged, so none can print "(V)";
		// fails_when=a home club alone sets the flag, or a member's or open slot reads
		// true;
		// no_claim=none beyond protects.
		it("does not flag a visitor, a member or an open slot", async () => {
			expect((await slotNow())?.assigneeIsVisitingToastmaster).toBe(false);
			const visitor = await holdAsGuest("visitor", "Leftover Club");
			expect(visitor?.assigneeIsGuest).toBe(true);
			expect(visitor?.assigneeIsVisitingToastmaster).toBe(false);
			await testDb
				.update(roleSlots)
				.set({
					assignedGuestId: null,
					assignedMemberId: seed.memberId,
					status: "claimed",
				})
				.where(eq(roleSlots.id, seed.slotId));
			const member = await slotNow();
			expect(member?.assigneeIsGuest).toBe(false);
			expect(member?.assigneeIsVisitingToastmaster).toBe(false);
		});
	},
);

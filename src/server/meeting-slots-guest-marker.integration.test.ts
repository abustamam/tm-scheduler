/**
 * `loadMeetingSlots` marks a guest holder as a guest and carries no caption
 * (#1208, #1164).
 *
 * The one loader the meeting page, the print route and the deck read slots
 * through. It carries no kind caption or home club: a Visitor reads
 * "Name · Guest" through `assigneeDisplay` and a visiting Toastmaster "Name (V)"
 * (the flag itself is pinned in `meeting-slots-visiting-marker.integration`).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, roleSlots } from "#/db/schema";
import { assigneeDisplay } from "#/lib/agenda-runsheet";
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

describe.skipIf(!hasTestDb)("loadMeetingSlots guest marker", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function holdSlotAsGuest(values: {
		kind: "visitor" | "visiting_toastmaster";
		homeClub: string | null;
	}) {
		const [guest] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{
						clubId: seed.clubId,
						name: "Ben Carter",
						email: `ben-${randomUUID()}@example.test`,
						...values,
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
		const slots = await loadMeetingSlots(seed.meetingId);
		return slots.find((s) => s.id === seed.slotId);
	}

	// protects=a visiting Toastmaster (with or without a home club) and a Visitor
	// (even with a leftover home club) all come out of the loader as a guest with
	// no caption, no raw kind and no home club, and display as "Ben Carter (V)" and
	// "Ben Carter · Guest" respectively;
	// fails_when=a kind caption comes back on a row, or the raw kind and home club
	// are carried through, or either kind loses the guest flag, or a home club makes
	// a Visitor read "(V)";
	// no_claim=the print and deck layouts; `agenda-parity.test.ts` pins those from
	// in-memory slots.
	it("reads a visiting Toastmaster as (V) and a Visitor as a guest, with no caption", async () => {
		for (const { values, display } of [
			{
				values: {
					kind: "visiting_toastmaster" as const,
					homeClub: "Downtown TM",
				},
				display: "Ben Carter (V)",
			},
			{
				values: { kind: "visiting_toastmaster" as const, homeClub: null },
				display: "Ben Carter (V)",
			},
			{
				values: { kind: "visitor" as const, homeClub: "Leftover Club" },
				display: "Ben Carter · Guest",
			},
		]) {
			const slot = await holdSlotAsGuest(values);
			expect(slot?.assigneeIsGuest, JSON.stringify(values)).toBe(true);
			expect(slot).not.toHaveProperty("assigneeGuestCaption");
			expect(slot).not.toHaveProperty("assigneeGuestKind");
			expect(slot).not.toHaveProperty("assigneeGuestHomeClub");
			expect(slot && assigneeDisplay(slot), JSON.stringify(values)).toBe(
				display,
			);
		}
	});

	// protects=an open slot and a member's slot are not flagged as guest-held;
	// fails_when=the flag is set from anything but `assignedGuestId`;
	// no_claim=none beyond protects.
	it("does not flag an open slot or a member's slot as a guest", async () => {
		const open = (await loadMeetingSlots(seed.meetingId)).find(
			(s) => s.id === seed.slotId,
		);
		expect(open?.assigneeIsGuest).toBe(false);
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.memberId, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
		const held = (await loadMeetingSlots(seed.meetingId)).find(
			(s) => s.id === seed.slotId,
		);
		expect(held?.assigneeId).toBe(seed.memberId);
		expect(held?.assigneeIsGuest).toBe(false);
	});
});

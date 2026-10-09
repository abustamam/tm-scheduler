/**
 * `loadMeetingSlots` captions a guest holder by kind and home club (#1059).
 *
 * The one loader the meeting page, the print route and the deck read slots
 * through, so this is where the caption has to come from for all of them to
 * agree. A Visitor, a member and an open slot carry no caption, which is what
 * keeps them reading exactly as before.
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
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadMeetingSlots } = await import("./meeting-slots-logic");

describe.skipIf(!hasTestDb)("loadMeetingSlots guest caption", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function holdSlotAsGuest(values: {
		kind: "visitor" | "visiting_toastmaster" | "guest_speaker";
		homeClub: string | null;
	}) {
		const [guest] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Ben Carter",
				email: `ben-${randomUUID()}@example.test`,
				...values,
			})
			.returning({ id: guests.id });
		if (!guest) throw new Error("guest insert failed");
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: guest.id, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
		const slots = await loadMeetingSlots(seed.meetingId);
		return slots.find((s) => s.id === seed.slotId);
	}

	it("captions a guest speaker with their home club", async () => {
		const slot = await holdSlotAsGuest({
			kind: "guest_speaker",
			homeClub: "Downtown Toastmasters",
		});
		expect(slot?.assigneeIsGuest).toBe(true);
		expect(slot?.assigneeGuestCaption).toBe(
			"Guest speaker, Downtown Toastmasters",
		);
		// The raw columns are read only to build the caption, not carried.
		expect(slot).not.toHaveProperty("assigneeGuestKind");
		expect(slot).not.toHaveProperty("assigneeGuestHomeClub");
	});

	it("gives a visiting Toastmaster no caption, home club or not", async () => {
		// Dropped from the agenda for now: the caption on every row they held
		// crowded the printed run of show onto a third sheet.
		for (const homeClub of [null, "GB TM"]) {
			const slot = await holdSlotAsGuest({
				kind: "visiting_toastmaster",
				homeClub,
			});
			expect(slot?.assigneeIsGuest).toBe(true);
			expect(slot?.assigneeGuestCaption).toBeNull();
		}
	});

	it("gives a Visitor no caption, even with a leftover home club", async () => {
		const slot = await holdSlotAsGuest({
			kind: "visitor",
			homeClub: "Leftover Club",
		});
		expect(slot?.assigneeIsGuest).toBe(true);
		expect(slot?.assigneeGuestCaption).toBeNull();
	});

	it("gives a member's slot and an open slot no caption", async () => {
		const open = (await loadMeetingSlots(seed.meetingId)).find(
			(s) => s.id === seed.slotId,
		);
		expect(open?.assigneeGuestCaption).toBeNull();
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.memberId, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
		const held = (await loadMeetingSlots(seed.meetingId)).find(
			(s) => s.id === seed.slotId,
		);
		expect(held?.assigneeId).toBe(seed.memberId);
		expect(held?.assigneeGuestCaption).toBeNull();
	});
});

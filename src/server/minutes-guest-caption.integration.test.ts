/**
 * `loadMinutes` captions a present guest by kind and home club (#1080).
 *
 * The one loader the roll-mode Guests group reads its rows through, so this is
 * where the caption has to come from. A guest reaches that list three ways —
 * a saved attendance row, a role slot, a Table Topics turn (#374) — and each
 * builder is its own query, so each is covered here. A Visitor carries no
 * caption KEY at all, which is what keeps their row the shape it was before
 * the field existed (and what keeps `minutes.integration.test.ts`'s `toEqual`
 * rows green without being told about the field).
 *
 * The whitespace case is the maintainer's note on #1080: a home club is free
 * text and may carry line breaks (#1081), and this string must be ONE line
 * for every reader of the row, so it is collapsed where the row is built.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAttendance,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadMinutes } = await import("./minutes-logic");

type GuestProfile = {
	kind: "visitor" | "visiting_toastmaster" | "guest_speaker";
	homeClub: string | null;
};

describe.skipIf(!hasTestDb)("loadMinutes guest caption (#1080)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function newGuest(name: string, profile: GuestProfile) {
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: seed.clubId, name, ...profile },
					testDb,
				),
			)
			.returning({ id: guests.id });
		if (!g) throw new Error("guest insert failed");
		return g.id;
	}

	/** The explicit way in: a saved attendance row, no mode recorded. */
	async function markPresent(guestId: string) {
		await testDb.insert(meetingAttendance).values({
			meetingId: seed.meetingId,
			guestId,
			status: "present",
		});
	}

	/** Took part by holding the seeded role slot (`fromRole`). */
	async function holdSlot(guestId: string) {
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: guestId, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
	}

	/** Took part by speaking at Table Topics only (`fromRole`, #374). */
	async function speakAtTableTopics(guestId: string) {
		await testDb
			.insert(tableTopicsSpeakers)
			.values({ meetingId: seed.meetingId, guestId });
	}

	async function guestRow(guestId: string) {
		const m = await loadMinutes(seed.meetingId);
		return m.guests.find((g) => g.guestId === guestId);
	}

	it("captions a guest speaker present by attendance row with their home club", async () => {
		const guestId = await newGuest("Ben Carter", {
			kind: "guest_speaker",
			homeClub: "Downtown Toastmasters",
		});
		await markPresent(guestId);

		const row = await guestRow(guestId);
		expect(row).toEqual({
			guestId,
			name: "Ben Carter",
			fromRole: false,
			caption: "Guest speaker, Downtown Toastmasters",
		});
		// The kind and home club are read only to build the caption, never
		// carried on the row.
		expect(row).not.toHaveProperty("kind");
		expect(row).not.toHaveProperty("homeClub");
	});

	it("captions a guest holding a role slot (fromRole) by kind alone when no home club is stored", async () => {
		const guestId = await newGuest("Nadia Visitor", {
			kind: "visiting_toastmaster",
			homeClub: null,
		});
		await holdSlot(guestId);

		expect(await guestRow(guestId)).toEqual({
			guestId,
			name: "Nadia Visitor",
			fromRole: true,
			caption: "Visiting Toastmaster",
		});
	});

	it("captions a guest who only spoke at Table Topics (fromRole, #374)", async () => {
		const guestId = await newGuest("Topics Only", {
			kind: "guest_speaker",
			homeClub: "Laguna Speakers #1234",
		});
		await speakAtTableTopics(guestId);

		expect(await guestRow(guestId)).toEqual({
			guestId,
			name: "Topics Only",
			fromRole: true,
			caption: "Guest speaker, Laguna Speakers #1234",
		});
	});

	it("gives a Visitor NO caption key, even with a leftover home club, so the row is the pre-#1080 shape (criterion 2)", async () => {
		const guestId = await newGuest("Just Visiting", {
			kind: "visitor",
			homeClub: "Leftover Club",
		});
		await holdSlot(guestId);

		const row = await guestRow(guestId);
		expect(row).toEqual({ guestId, name: "Just Visiting", fromRole: true });
		// Absent, not null: `toEqual` treats a `null` property as a difference.
		expect(row).not.toHaveProperty("caption");
	});

	it("gives a guest with no kind stored no caption either (the column's default is Visitor)", async () => {
		// Every guest from before #1046 reads as `visitor` through the column
		// default, so this is the "no kind stored" case the issue names.
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: seed.clubId, name: "Default Kind" },
					testDb,
				),
			)
			.returning({ id: guests.id });
		if (!g) throw new Error("guest insert failed");
		await markPresent(g.id);

		const row = await guestRow(g.id);
		expect(row).toEqual({
			guestId: g.id,
			name: "Default Kind",
			fromRole: false,
		});
		expect(row).not.toHaveProperty("caption");
	});

	it("holds a home club with line breaks and runs of whitespace to ONE line", async () => {
		const guestId = await newGuest("Multi Line", {
			kind: "guest_speaker",
			homeClub: "Downtown\n  Toastmasters\t\t#1234\r\n",
		});
		await markPresent(guestId);

		expect((await guestRow(guestId))?.caption).toBe(
			"Guest speaker, Downtown Toastmasters #1234",
		);
	});

	it("collapses the role-slot and Table Topics captions the same way as the attendance-row one", async () => {
		// Three builders, one collapse: a line break that one of them let
		// through would reach the badge from exactly that path.
		const viaSlot = await newGuest("Via Slot", {
			kind: "visiting_toastmaster",
			homeClub: "Laguna\nSpeakers",
		});
		await holdSlot(viaSlot);
		const viaTopics = await newGuest("Via Topics", {
			kind: "guest_speaker",
			homeClub: "Harbour   Orators",
		});
		await speakAtTableTopics(viaTopics);

		expect((await guestRow(viaSlot))?.caption).toBe(
			"Visiting Toastmaster, Laguna Speakers",
		);
		expect((await guestRow(viaTopics))?.caption).toBe(
			"Guest speaker, Harbour Orators",
		);
	});

	it("keeps the caption when an explicit attendance row wins over a role slot", async () => {
		// `loadMinutes` lists such a guest ONCE, as explicitly present; the
		// caption must ride on the row that wins, not only on the one it beats.
		const guestId = await newGuest("Both Ways", {
			kind: "guest_speaker",
			homeClub: "Downtown Toastmasters",
		});
		await holdSlot(guestId);
		await markPresent(guestId);

		const m = await loadMinutes(seed.meetingId);
		const rows = m.guests.filter((g) => g.guestId === guestId);
		expect(rows).toEqual([
			{
				guestId,
				name: "Both Ways",
				fromRole: false,
				caption: "Guest speaker, Downtown Toastmasters",
			},
		]);
	});
});

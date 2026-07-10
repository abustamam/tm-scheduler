/**
 * DB-backed integration tests for guest assignment (#151).
 *
 * Exercises the REAL guest-assign logic + the mutual-exclusivity invariant
 * (logic AND the DB check constraint) + name resolution on a read path (season
 * grid) + roster/picker exclusion, against a live Postgres identified by
 * TEST_DATABASE_URL. `#/db` is mocked to the test client so the logic modules
 * import cleanly without a production DATABASE_URL.
 *
 * When TEST_DATABASE_URL is unset the whole suite is skipped.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, members, roleSlots } from "#/db/schema";
import { projectGrid } from "#/lib/season-grid-view";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyAssignGuestToSlot, listClubGuests } = await import(
	"#/server/guests-logic"
);
const { loadSeasonGrid } = await import("#/server/season-grid-logic");
const { reassignSlotCore } = await import("#/server/slots-logic");

describe.skipIf(!hasTestDb)("guest assignment (#151)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function slotState(slotId: string) {
		const [row] = await testDb
			.select({
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				assignedGuestId: roleSlots.assignedGuestId,
				speechId: roleSlots.speechId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId))
			.limit(1);
		return row!;
	}

	it("assigns a NEW club guest to a slot (name + optional contact)", async () => {
		const res = await applyAssignGuestToSlot({
			slotId: seed.slotId,
			newGuest: { name: "Ben Carter", email: "ben@example.com" },
			actorMemberId: seed.adminMemberId,
		});

		const st = await slotState(seed.slotId);
		expect(st.assignedGuestId).toBe(res.guestId);
		expect(st.assignedMemberId).toBeNull();
		expect(st.status).toBe("claimed");

		const [g] = await testDb
			.select({
				clubId: guests.clubId,
				name: guests.name,
				email: guests.email,
			})
			.from(guests)
			.where(eq(guests.id, res.guestId))
			.limit(1);
		expect(g).toMatchObject({
			clubId: seed.clubId,
			name: "Ben Carter",
			email: "ben@example.com",
		});
	});

	it("assigns an EXISTING club guest without creating a duplicate", async () => {
		const [existing] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Nadia Visitor" })
			.returning({ id: guests.id });

		await applyAssignGuestToSlot({
			slotId: seed.slotId,
			guestId: existing!.id,
			actorMemberId: null,
		});

		const st = await slotState(seed.slotId);
		expect(st.assignedGuestId).toBe(existing!.id);

		const all = await listClubGuests(seed.clubId);
		expect(all.filter((x) => x.name === "Nadia Visitor")).toHaveLength(1);
	});

	it("clears a member assignee when a guest is assigned (mutual exclusivity)", async () => {
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.memberId, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));

		await applyAssignGuestToSlot({
			slotId: seed.slotId,
			newGuest: { name: "Guesty" },
			actorMemberId: null,
		});

		const st = await slotState(seed.slotId);
		expect(st.assignedMemberId).toBeNull();
		expect(st.assignedGuestId).not.toBeNull();
	});

	it("rejects a row holding BOTH a member and a guest (DB check constraint)", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Both" })
			.returning({ id: guests.id });

		await expect(
			testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId, assignedGuestId: g!.id })
				.where(eq(roleSlots.id, seed.slotId)),
		).rejects.toThrow();
	});

	it("clears a guest assignee when reassigning to a member (mutual exclusivity)", async () => {
		await applyAssignGuestToSlot({
			slotId: seed.slotId,
			newGuest: { name: "Temp Guest" },
			actorMemberId: null,
		});

		await testDb.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId: seed.slotId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			}),
		);

		const st = await slotState(seed.slotId);
		expect(st.assignedGuestId).toBeNull();
		expect(st.assignedMemberId).toBe(seed.memberId);
	});

	it("resolves the guest name with a Guest marker on a read path (season grid)", async () => {
		const res = await applyAssignGuestToSlot({
			slotId: seed.slotId,
			newGuest: { name: "Ben Carter" },
			actorMemberId: null,
		});

		const data = await loadSeasonGrid({ clubId: seed.clubId, count: "all" });
		const cell = data.cells.find((c) => c.guestId === res.guestId);
		expect(cell).toBeDefined();
		expect(cell?.memberId).toBeNull();
		expect(data.guestNames).toContainEqual({
			id: res.guestId,
			name: "Ben Carter",
		});

		const rows = projectGrid(data, "roles");
		const texts = rows.flatMap((r) => r.cells.map((c) => c.text));
		expect(texts).toContain("Ben Carter · Guest");
	});

	it("keeps guests out of the member roster and picker", async () => {
		await applyAssignGuestToSlot({
			slotId: seed.slotId,
			newGuest: { name: "Visitor V" },
			actorMemberId: null,
		});

		const roster = await testDb
			.select({ name: members.name })
			.from(members)
			.where(eq(members.clubId, seed.clubId));
		expect(roster.map((m) => m.name)).not.toContain("Visitor V");

		const guestList = await listClubGuests(seed.clubId);
		expect(guestList.map((g) => g.name)).toContain("Visitor V");
	});
});

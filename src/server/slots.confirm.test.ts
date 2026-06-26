/**
 * DB-backed integration tests for the confirmSlot / unconfirmSlot lifecycle.
 *
 * These tests run against a real Postgres instance identified by TEST_DATABASE_URL.
 * They reproduce the exact conditional UPDATE guards from `src/server/slots.ts`
 * without importing request-bound code like `requireUser` or `getSessionUser`.
 *
 * When TEST_DATABASE_URL is unset, the whole suite is skipped (never fails and
 * never touches the production DATABASE_URL).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5434/tm_test \
 *     bunx vitest run src/server/slots.confirm.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clubMemberships, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

// ---------------------------------------------------------------------------
// Helpers — replicate the core Drizzle operations from slots.ts
// ---------------------------------------------------------------------------

/** Set a slot to 'claimed' (prerequisite for confirmSlot) */
async function setSlotClaimed(slotId: string, userId: string) {
	await testDb
		.update(roleSlots)
		.set({ assignedUserId: userId, status: "claimed", claimedAt: new Date() })
		.where(eq(roleSlots.id, slotId));
}

/** Mirror of the confirmSlot conditional UPDATE in slots.ts */
async function confirmSlotTx(slotId: string) {
	return testDb
		.update(roleSlots)
		.set({ status: "confirmed" })
		.where(and(eq(roleSlots.id, slotId), eq(roleSlots.status, "claimed")))
		.returning({ id: roleSlots.id });
}

/** Mirror of the unconfirmSlot conditional UPDATE in slots.ts */
async function unconfirmSlotTx(slotId: string) {
	return testDb
		.update(roleSlots)
		.set({ status: "claimed" })
		.where(and(eq(roleSlots.id, slotId), eq(roleSlots.status, "confirmed")))
		.returning({ id: roleSlots.id });
}

// ---------------------------------------------------------------------------
// Suite — gated on a real test DB. With no TEST_DATABASE_URL the hooks (which
// query the DB via seedClub) never run, so `vitest run` skips cleanly.
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("confirmSlot + unconfirmSlot integration", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	// -------------------------------------------------------------------------
	// Transition: claimed → confirmed
	// -------------------------------------------------------------------------

	it("claimed slot confirmed by admin becomes confirmed", async () => {
		await setSlotClaimed(seed.slotId, seed.memberUserId);

		const result = await confirmSlotTx(seed.slotId);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe(seed.slotId);

		const [row] = await testDb
			.select({ status: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);

		expect(row?.status).toBe("confirmed");
	});

	// -------------------------------------------------------------------------
	// Guard: open slots cannot be confirmed
	// -------------------------------------------------------------------------

	it("open slot cannot be confirmed — conditional update returns 0 rows", async () => {
		// Slot starts as 'open' from seedClub; no claim step here.
		const result = await confirmSlotTx(seed.slotId);
		expect(result).toHaveLength(0);

		const [row] = await testDb
			.select({ status: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);

		// Status is unchanged
		expect(row?.status).toBe("open");
	});

	// -------------------------------------------------------------------------
	// Transition: confirmed → claimed (unconfirm)
	// -------------------------------------------------------------------------

	it("confirmed slot can be unconfirmed back to claimed", async () => {
		await setSlotClaimed(seed.slotId, seed.memberUserId);
		await confirmSlotTx(seed.slotId);

		const result = await unconfirmSlotTx(seed.slotId);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe(seed.slotId);

		const [row] = await testDb
			.select({ status: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);

		expect(row?.status).toBe("claimed");
	});

	// -------------------------------------------------------------------------
	// Race: released-then-confirm → conditional guard returns 0 rows
	// -------------------------------------------------------------------------

	it("race: confirm after release returns 0 rows (conditional guard)", async () => {
		// Claim, then release back to open.
		await setSlotClaimed(seed.slotId, seed.memberUserId);
		await testDb
			.update(roleSlots)
			.set({ assignedUserId: null, status: "open", claimedAt: null })
			.where(eq(roleSlots.id, seed.slotId));

		// Attempt to confirm a now-open slot: WHERE status='claimed' is false.
		const result = await confirmSlotTx(seed.slotId);
		expect(result).toHaveLength(0);

		const [row] = await testDb
			.select({ status: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);

		expect(row?.status).toBe("open");
	});

	// -------------------------------------------------------------------------
	// Authorization: member role is rejected by admin/vpe guard
	// -------------------------------------------------------------------------

	it("member role is rejected by ['admin','vpe'] guard check", async () => {
		// Mirror the requireClubRole predicate from guards.ts:55-65
		const [membership] = await testDb
			.select()
			.from(clubMemberships)
			.where(
				and(
					eq(clubMemberships.userId, seed.memberUserId),
					eq(clubMemberships.clubId, seed.clubId),
				),
			)
			.limit(1);

		const allowedRoles: Array<"admin" | "vpe"> = ["admin", "vpe"];
		const memberPasses =
			membership != null &&
			allowedRoles.includes(membership.clubRole as "admin" | "vpe");

		expect(memberPasses).toBe(false);
	});

	it("admin role passes the ['admin','vpe'] guard check", async () => {
		const [membership] = await testDb
			.select()
			.from(clubMemberships)
			.where(
				and(
					eq(clubMemberships.userId, seed.adminUserId),
					eq(clubMemberships.clubId, seed.clubId),
				),
			)
			.limit(1);

		const allowedRoles: Array<"admin" | "vpe"> = ["admin", "vpe"];
		const adminPasses =
			membership != null &&
			allowedRoles.includes(membership.clubRole as "admin" | "vpe");

		expect(adminPasses).toBe(true);
	});
});

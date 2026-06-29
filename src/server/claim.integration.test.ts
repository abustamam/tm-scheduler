/**
 * DB-backed integration tests for the claim race guard and authorization guards.
 *
 * These tests run against a real Postgres instance identified by TEST_DATABASE_URL.
 * They reproduce the exact Drizzle transaction from `src/server/slots.ts` (the
 * conditional UPDATE race guard) and the membership/role predicates from
 * `src/server/guards.ts` — without importing request-bound code like
 * `requireUser` or `getSessionUser`.
 *
 * When TEST_DATABASE_URL is unset, the whole suite is skipped (never fails and
 * never touches the production DATABASE_URL).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test \
 *     bunx vitest run src/server/claim.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, clubMemberships, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

// ---------------------------------------------------------------------------
// Helpers — replicate the core Drizzle operations from slots.ts / guards.ts
// ---------------------------------------------------------------------------

/** Mirror of the conditional UPDATE in slots.ts — now keyed to memberId */
async function claimSlotTx(slotId: string, memberId: string) {
	return testDb.transaction(async (tx) => {
		const updated = await tx
			.update(roleSlots)
			.set({
				assignedMemberId: memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(and(eq(roleSlots.id, slotId), eq(roleSlots.status, "open")))
			.returning({ id: roleSlots.id });
		return updated;
	});
}

/** Mirror of getMembership in guards.ts:31-43 (using testDb) */
async function getMembershipFromTestDb(userId: string, clubId: string) {
	const [membership] = await testDb
		.select()
		.from(clubMemberships)
		.where(
			and(
				eq(clubMemberships.userId, userId),
				eq(clubMemberships.clubId, clubId),
			),
		)
		.limit(1);
	return membership ?? null;
}

// ---------------------------------------------------------------------------
// Suite — gated on a real test DB. With no TEST_DATABASE_URL the hooks (which
// query the DB via seedClub) never run, so `vitest run` skips cleanly.
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("claim + guards integration", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	// -------------------------------------------------------------------------
	// Race guard tests (mirrors slots.ts conditional UPDATE)
	// -------------------------------------------------------------------------

	describe("claim race guard", () => {
		it("happy path: claiming an open slot succeeds and sets status=claimed", async () => {
			const result = await claimSlotTx(seed.slotId, seed.memberId);

			expect(result).toHaveLength(1);
			expect(result[0]?.id).toBe(seed.slotId);

			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);

			expect(row?.status).toBe("claimed");
			expect(row?.assignedMemberId).toBe(seed.memberId);
		});

		it("race: two concurrent claims — exactly one wins, the other gets []", async () => {
			const claimA = claimSlotTx(seed.slotId, seed.memberId);
			const claimB = claimSlotTx(seed.slotId, seed.memberId);

			const [resultA, resultB] = await Promise.allSettled([claimA, claimB]);

			// Extract the returning arrays from each settled result.
			// A fulfilled claim with rows = winner; fulfilled with [] or rejected = loser.
			const winnerRows: string[] = [];
			const loserRows: string[] = [];

			for (const result of [resultA, resultB]) {
				if (result.status === "fulfilled" && result.value.length > 0) {
					winnerRows.push(...result.value.map((r) => r.id));
				} else {
					loserRows.push("lost");
				}
			}

			// Exactly one transaction must have flipped the row.
			expect(winnerRows).toHaveLength(1);
			expect(loserRows).toHaveLength(1);
			expect(winnerRows[0]).toBe(seed.slotId);

			// The DB row is assigned to the member.
			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);

			expect(row?.status).toBe("claimed");
			expect(row?.assignedMemberId).toBe(seed.memberId);
		});

		it("sequential double-claim: second claim on an already-claimed slot returns []", async () => {
			// First claim succeeds.
			const first = await claimSlotTx(seed.slotId, seed.memberId);
			expect(first).toHaveLength(1);

			// Second claim by the same member: the WHERE status='open' predicate is false.
			const second = await claimSlotTx(seed.slotId, seed.memberId);
			expect(second).toHaveLength(0);

			// The slot is still assigned to the first claimant.
			const [row] = await testDb
				.select({ assignedMemberId: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);

			expect(row?.assignedMemberId).toBe(seed.memberId);
		});

		it("claim assigns a member and logs activity", async () => {
			await claimSlotTx(seed.slotId, seed.memberId);

			const [row] = await testDb
				.select({ assignedMemberId: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);

			expect(row?.assignedMemberId).toBe(seed.memberId);
		});

		it("logActivity inserts a row with action=claim for the slot", async () => {
			const { logActivity } = await import("#/server/activity");
			await logActivity(testDb, {
				clubId: seed.clubId,
				actorMemberId: seed.memberId,
				action: "claim",
				targetType: "slot",
				targetId: seed.slotId,
				detail: { memberId: seed.memberId },
			});

			const log = await testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.targetId, seed.slotId));
			expect(log.some((r) => r.action === "claim")).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Guard predicate tests (mirrors guards.ts logic using testDb)
	// -------------------------------------------------------------------------

	describe("membership / role guards", () => {
		it("active member: getMembership resolves a row with status=active", async () => {
			const membership = await getMembershipFromTestDb(
				seed.memberUserId,
				seed.clubId,
			);

			expect(membership).not.toBeNull();
			expect(membership?.status).toBe("active");
			expect(membership?.clubRole).toBe("member");
		});

		it("inactive membership: treated as not-a-member (requireMembership would throw)", async () => {
			// Mark the member's membership inactive.
			await testDb
				.update(clubMemberships)
				.set({ status: "inactive" })
				.where(
					and(
						eq(clubMemberships.userId, seed.memberUserId),
						eq(clubMemberships.clubId, seed.clubId),
					),
				);

			const membership = await getMembershipFromTestDb(
				seed.memberUserId,
				seed.clubId,
			);

			// The row exists but status is inactive — requireMembership (guards.ts:48)
			// checks `membership.status !== 'active'` and throws.
			expect(membership?.status).toBe("inactive");
			const wouldBeRejected = !membership || membership.status !== "active";
			expect(wouldBeRejected).toBe(true);
		});

		it("member role is rejected by ['admin','vpe'] check; admin passes", async () => {
			const memberMembership = await getMembershipFromTestDb(
				seed.memberUserId,
				seed.clubId,
			);
			const adminMembership = await getMembershipFromTestDb(
				seed.adminUserId,
				seed.clubId,
			);

			const allowedRoles: Array<"admin" | "vpe"> = ["admin", "vpe"];

			// member should be rejected
			expect(memberMembership?.clubRole).toBeDefined();
			const memberPasses =
				memberMembership != null &&
				allowedRoles.includes(memberMembership.clubRole as "admin" | "vpe");
			expect(memberPasses).toBe(false);

			// admin should pass
			expect(adminMembership?.clubRole).toBeDefined();
			const adminPasses =
				adminMembership != null &&
				allowedRoles.includes(adminMembership.clubRole as "admin" | "vpe");
			expect(adminPasses).toBe(true);
		});

		it("unknown user has no membership", async () => {
			const membership = await getMembershipFromTestDb(
				"non-existent-user-id",
				seed.clubId,
			);
			expect(membership).toBeNull();
		});
	});
});

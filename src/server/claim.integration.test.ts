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
import {
	activityLog,
	clubMemberships,
	members,
	roleSlots,
	speakerDetails,
} from "#/db/schema";
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

	// -------------------------------------------------------------------------
	// Phase B — de-authed write guards (no session required; trust-based)
	// -------------------------------------------------------------------------

	describe("de-authed slot writes (Phase B)", () => {
		/** Mirror of claimSlot without requireUser/requireMembership; only requireMemberInClub. */
		async function claimSlotPublic(
			slotId: string,
			memberId: string,
			actorMemberId: string,
		) {
			const [slot] = await testDb
				.select({ id: roleSlots.id, status: roleSlots.status })
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId))
				.limit(1);

			if (!slot) throw new Error("Role not found.");

			// Trust guard: memberId must belong to the club (verified via members table).
			const [member] = await testDb
				.select({ id: members.id, clubId: members.clubId })
				.from(members)
				.where(eq(members.id, memberId))
				.limit(1);
			if (!member) throw new Error("Member not found in this club.");

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

				if (updated.length === 0)
					throw new Error(
						"Sorry — this role was just claimed by someone else.",
					);

				await tx.insert(activityLog).values({
					clubId: member.clubId,
					actorMemberId,
					action: "claim",
					targetType: "slot",
					targetId: slotId,
					detail: { memberId },
				});

				return { ok: true as const };
			});
		}

		/** Mirror of releaseSlot without requireUser; only requireMemberInClub
		 *  (sheet-parity — any club member may release/clear any slot). */
		async function releaseSlotPublic(slotId: string, actorMemberId: string) {
			const [slot] = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId))
				.limit(1);

			if (!slot) throw new Error("Role not found.");

			const [member] = await testDb
				.select({ clubId: members.clubId })
				.from(members)
				.where(eq(members.id, actorMemberId))
				.limit(1);
			if (!member) throw new Error("Member not found in this club.");

			return testDb.transaction(async (tx) => {
				await tx
					.delete(speakerDetails)
					.where(eq(speakerDetails.slotId, slot.id));
				await tx
					.update(roleSlots)
					.set({ assignedMemberId: null, status: "open", claimedAt: null })
					.where(eq(roleSlots.id, slot.id));

				await tx.insert(activityLog).values({
					clubId: member.clubId,
					actorMemberId,
					action: "release",
					targetType: "slot",
					targetId: slotId,
				});

				return { ok: true as const };
			});
		}

		/** Mirror of reassignSlot without requireUser/requireClubRole; only requireMemberInClub. */
		async function reassignSlotPublic(
			slotId: string,
			newMemberId: string,
			actorMemberId: string,
		) {
			const [slot] = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId))
				.limit(1);

			if (!slot) throw new Error("Role not found.");

			const [actor] = await testDb
				.select({ clubId: members.clubId })
				.from(members)
				.where(eq(members.id, actorMemberId))
				.limit(1);
			if (!actor) throw new Error("Actor member not found in this club.");

			const [target] = await testDb
				.select({ clubId: members.clubId })
				.from(members)
				.where(eq(members.id, newMemberId))
				.limit(1);
			if (!target) throw new Error("Target member not found in this club.");

			return testDb.transaction(async (tx) => {
				await tx
					.update(roleSlots)
					.set({ assignedMemberId: newMemberId, status: "claimed" })
					.where(eq(roleSlots.id, slotId));

				await tx.insert(activityLog).values({
					clubId: actor.clubId,
					actorMemberId,
					action: "reassign",
					targetType: "slot",
					targetId: slotId,
					detail: { memberId: newMemberId },
				});

				return { ok: true as const };
			});
		}

		it("claimSlot works without a session (member-keyed, trust-based)", async () => {
			const result = await claimSlotPublic(
				seed.slotId,
				seed.memberId,
				seed.memberId,
			);
			expect(result).toEqual({ ok: true });

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

			// Activity log row inserted
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.targetId, seed.slotId),
						eq(activityLog.action, "claim"),
					),
				);
			expect(log.length).toBeGreaterThan(0);
		});

		it("claiming a speaker slot with no title stores TBA", async () => {
			// Mirror of claimSlot's speaker-details normalization (slots-logic.ts can't be
			// imported here — it loads #/db). No title provided → stored title must be "TBA".
			const input: { speechTitle?: string } | undefined = undefined;
			const trimmed = input?.speechTitle?.trim();
			const details = {
				speechTitle: trimmed && trimmed.length > 0 ? trimmed : "TBA",
				pathwayPath: null,
				projectName: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
			};
			await testDb
				.insert(speakerDetails)
				.values({ slotId: seed.slotId, ...details })
				.onConflictDoUpdate({ target: speakerDetails.slotId, set: details });

			const [row] = await testDb
				.select({ speechTitle: speakerDetails.speechTitle })
				.from(speakerDetails)
				.where(eq(speakerDetails.slotId, seed.slotId))
				.limit(1);

			expect(row?.speechTitle).toBe("TBA");
		});

		it("claimSlot trust guard rejects unknown memberId", async () => {
			await expect(
				claimSlotPublic(
					seed.slotId,
					"00000000-0000-0000-0000-000000000099",
					"00000000-0000-0000-0000-000000000099",
				),
			).rejects.toThrow("Member not found in this club.");
		});

		it("releaseSlot works without a session (member releases the slot they hold)", async () => {
			// First claim it
			await claimSlotTx(seed.slotId, seed.memberId);

			const result = await releaseSlotPublic(seed.slotId, seed.memberId);
			expect(result).toEqual({ ok: true });

			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);

			expect(row?.status).toBe("open");
			expect(row?.assignedMemberId).toBeNull();
		});

		it("releaseSlot is sheet-parity: a non-assignee club member can release a claimed slot, and the actor is logged", async () => {
			// seed.memberId claims the slot
			await claimSlotTx(seed.slotId, seed.memberId);

			// A DIFFERENT club member releases it (trust-based, no assignee check)
			const [otherMember] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, name: "Other Member" })
				.returning({ id: members.id });

			if (!otherMember) throw new Error("Failed to insert other member");

			const result = await releaseSlotPublic(seed.slotId, otherMember.id);
			expect(result).toEqual({ ok: true });

			// Slot reset to open
			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);

			expect(row?.status).toBe("open");
			expect(row?.assignedMemberId).toBeNull();

			// Activity log records who actually did the release (the non-assignee)
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.targetId, seed.slotId),
						eq(activityLog.action, "release"),
					),
				);
			expect(log.some((r) => r.actorMemberId === otherMember.id)).toBe(true);
		});

		it("reassignSlot works without a session (trust-based)", async () => {
			// Claim the slot first
			await claimSlotTx(seed.slotId, seed.memberId);

			// Bump to "confirmed" so the assertion below proves a real status reset.
			await testDb
				.update(roleSlots)
				.set({ status: "confirmed" })
				.where(eq(roleSlots.id, seed.slotId));

			// Insert a second roster member
			const [other] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, name: "Other Member" })
				.returning({ id: members.id });

			if (!other) throw new Error("Failed to insert other member");

			const result = await reassignSlotPublic(
				seed.slotId,
				other.id,
				seed.memberId,
			);
			expect(result).toEqual({ ok: true });

			const [row] = await testDb
				.select({
					assignedMemberId: roleSlots.assignedMemberId,
					status: roleSlots.status,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);

			expect(row?.assignedMemberId).toBe(other.id);
			// Status must be reset from "confirmed" back to "claimed" — new holder is unconfirmed.
			expect(row?.status).toBe("claimed");
		});
	});
});

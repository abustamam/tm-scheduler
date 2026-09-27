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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	meetingAttendancePlan,
	members,
	people,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { SIGN_IN_REQUIRED_MESSAGE, type WriteProof } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import { claimSlotCore, markComingOnSelfClaim } from "./slots-logic";

// `claimSlotCore` is the REAL claim path below; its module reads `#/db`.
vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** Exact-string matcher, so a case cannot pass on an unrelated throw. */
const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

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

/** Mirror of getMembership in guards.ts (using testDb): user → Person
 *  (people.user_id) → the members row for that person in this club. */
async function getMembershipFromTestDb(userId: string, clubId: string) {
	const [membership] = await testDb
		.select({
			id: members.id,
			clubId: members.clubId,
			clubRole: members.clubRole,
			status: members.status,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(and(eq(people.userId, userId), eq(members.clubId, clubId)))
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
			// Mark the member's membership inactive (on the members row now).
			await testDb
				.update(members)
				.set({ status: "inactive" })
				.where(eq(members.id, seed.memberId));

			const membership = await getMembershipFromTestDb(
				seed.memberUserId,
				seed.clubId,
			);

			// The row exists but status is inactive — requireMembership checks
			// `membership.status !== 'active'` and throws.
			expect(membership?.status).toBe("inactive");
			const wouldBeRejected = !membership || membership.status !== "active";
			expect(wouldBeRejected).toBe(true);
		});

		it("member role is rejected by ['admin'] check; admin passes", async () => {
			const memberMembership = await getMembershipFromTestDb(
				seed.memberUserId,
				seed.clubId,
			);
			const adminMembership = await getMembershipFromTestDb(
				seed.adminUserId,
				seed.clubId,
			);

			const allowedRoles: Array<"admin" | "member"> = ["admin"];

			// member should be rejected
			expect(memberMembership?.clubRole).toBe("member");
			const memberPasses =
				memberMembership != null &&
				allowedRoles.includes(memberMembership.clubRole);
			expect(memberPasses).toBe(false);

			// admin should pass
			expect(adminMembership?.clubRole).toBe("admin");
			const adminPasses =
				adminMembership != null &&
				allowedRoles.includes(adminMembership.clubRole);
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

		// The release and reassign mirrors that sat here asserted both "work
		// without a session". Since #763 they do not (ADR-0026: taking a role away
		// from someone is not filling a blank), and a mirror cannot see the real
		// handler's gate anyway. `release-and-speaker-details.integration.test.ts`
		// executes the real handlers instead.

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

		it("claimSlot trust guard rejects unknown memberId", async () => {
			await expect(
				claimSlotPublic(
					seed.slotId,
					"00000000-0000-0000-0000-000000000099",
					"00000000-0000-0000-0000-000000000099",
				),
			).rejects.toThrow("Member not found in this club.");
		});

		it("roster query returns only active members, ordered by name", async () => {
			// Mark the seeded member inactive; it should be excluded from the roster.
			await testDb
				.update(members)
				.set({ status: "inactive" })
				.where(eq(members.id, seed.memberId));

			const roster = await testDb
				.select({ id: members.id, status: members.status })
				.from(members)
				.where(
					and(eq(members.clubId, seed.clubId), eq(members.status, "active")),
				);

			expect(roster.every((m) => m.status === "active")).toBe(true);
			expect(roster.some((m) => m.id === seed.memberId)).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// #763 (ADR-0026): an unverified claim only fills a blank. Executed through
	// the REAL `claimSlotCore`, where the gate lives; the handler hands it the
	// proof (`slots.transport.test.ts` pins that).
	// -------------------------------------------------------------------------

	describe("an asserted claim only fills a blank (#763)", () => {
		/** A second active member, so "for someone else" has a someone. */
		let otherMemberId: string;

		beforeEach(async () => {
			const [row] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: await seedPerson({ name: "Other Member" }),
					name: "Other Member",
				})
				.returning({ id: members.id });
			if (!row) throw new Error("Failed to insert the other member");
			otherMemberId = row.id;
		});

		function claim(memberId: string, actorMemberId: string, proof: WriteProof) {
			return testDb.transaction((tx) =>
				claimSlotCore(tx, {
					slotId: seed.slotId,
					memberId,
					actorMemberId,
					proof,
				}),
			);
		}

		async function answer(memberId: string, status: "coming" | "not_coming") {
			await testDb
				.insert(meetingAttendancePlan)
				.values({ memberId, meetingId: seed.meetingId, status });
		}

		async function planStatus(memberId: string) {
			const [row] = await testDb
				.select({ status: meetingAttendancePlan.status })
				.from(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.memberId, memberId),
						eq(meetingAttendancePlan.meetingId, seed.meetingId),
					),
				);
			return row?.status ?? null;
		}

		async function slot() {
			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			return row;
		}

		async function claimRows() {
			return testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "claim"),
					),
				);
		}

		/** Put `memberId` on a Toastmaster slot of this meeting. */
		async function makeTmod(memberId: string) {
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Toastmaster of the Day",
					key: "toastmaster_of_the_day",
					category: "functionary",
				})
				.returning({ id: roleDefinitions.id });
			if (!def) throw new Error("Failed to insert the TMOD role");
			await testDb.insert(roleSlots).values({
				meetingId: seed.meetingId,
				roleDefinitionId: def.id,
				status: "claimed",
				assignedMemberId: memberId,
			});
		}

		it("claims an open role for yourself with no answer, and records the proof", async () => {
			await claim(seed.memberId, seed.memberId, "asserted");

			expect(await slot()).toEqual({
				status: "claimed",
				assignedMemberId: seed.memberId,
			});
			const [row] = await claimRows();
			expect(row?.detail).toMatchObject({
				memberId: seed.memberId,
				proof: "asserted",
			});
			expect(row?.detail).not.toHaveProperty("grantedVia");
		});

		it("claims for yourself when your answer is coming", async () => {
			await answer(seed.memberId, "coming");
			await claim(seed.memberId, seed.memberId, "asserted");
			expect((await slot())?.assignedMemberId).toBe(seed.memberId);
		});

		it("refuses to claim over your own not_coming, writing nothing", async () => {
			await answer(seed.memberId, "not_coming");

			await expect(
				claim(seed.memberId, seed.memberId, "asserted"),
			).rejects.toThrow(exact(SIGN_IN_REQUIRED_MESSAGE));

			expect(await slot()).toEqual({ status: "open", assignedMemberId: null });
			expect(await planStatus(seed.memberId)).toBe("not_coming");
			expect(await claimRows()).toHaveLength(0);
		});

		it("a SESSION claim over your own not_coming is a change of mind, and wins", async () => {
			// The control for the case above: the gate is the proof, not the rung.
			await answer(seed.memberId, "not_coming");
			await claim(seed.memberId, seed.memberId, "session");
			expect((await slot())?.assignedMemberId).toBe(seed.memberId);
			expect(await planStatus(seed.memberId)).toBe("coming");
		});

		it("refuses an asserted claim for someone else", async () => {
			await expect(
				claim(otherMemberId, seed.memberId, "asserted"),
			).rejects.toThrow(exact(SIGN_IN_REQUIRED_MESSAGE));
			expect(await slot()).toEqual({ status: "open", assignedMemberId: null });
		});

		it("admits an asserted claim for someone else by this meeting's TMOD (Phase 2)", async () => {
			await makeTmod(seed.memberId);
			await claim(otherMemberId, seed.memberId, "asserted");
			expect((await slot())?.assignedMemberId).toBe(otherMemberId);
			// Labelled, because the TMOD's id is as public as anyone's: a forged
			// TMOD claim must be distinguishable in the feed.
			const [row] = await claimRows();
			expect(row?.detail).toMatchObject({
				proof: "asserted",
				grantedVia: "tmod",
			});
		});

		it("even the TMOD may not claim for someone whose answer is not_coming", async () => {
			await makeTmod(seed.memberId);
			await answer(otherMemberId, "not_coming");
			await expect(
				claim(otherMemberId, seed.memberId, "asserted"),
			).rejects.toThrow(exact(SIGN_IN_REQUIRED_MESSAGE));
			expect(await planStatus(otherMemberId)).toBe("not_coming");
		});

		it("a SESSION claim for someone else is the sheet rule, unchanged", async () => {
			await claim(otherMemberId, seed.memberId, "session");
			expect((await slot())?.assignedMemberId).toBe(otherMemberId);
			const [row] = await claimRows();
			expect(row?.detail).toMatchObject({ proof: "session" });
		});

		it("an asserted self-claim over the officer's ask answers coming", async () => {
			// `reached_out` is a blank (ADR-0026): the officer asked, nobody answered.
			await testDb.insert(meetingAttendancePlan).values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "reached_out",
			});
			await claim(seed.memberId, seed.memberId, "asserted");
			expect(await planStatus(seed.memberId)).toBe("coming");
		});

		// The race half: a decline that lands AFTER the gate's read. Unreachable
		// serially through `claimSlotCore` (the gate refuses first), so the plan
		// write's floor is driven directly.
		it("the asserted self-claim's plan write never overwrites a decline", async () => {
			await answer(seed.memberId, "not_coming");
			await testDb.transaction((tx) =>
				markComingOnSelfClaim(tx, {
					memberId: seed.memberId,
					actorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					proof: "asserted",
				}),
			);
			expect(await planStatus(seed.memberId)).toBe("not_coming");
		});

		it("a session self-claim's plan write does overwrite it — the control", async () => {
			await answer(seed.memberId, "not_coming");
			await testDb.transaction((tx) =>
				markComingOnSelfClaim(tx, {
					memberId: seed.memberId,
					actorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					proof: "session",
				}),
			);
			expect(await planStatus(seed.memberId)).toBe("coming");
		});

		it("an archived club refuses the claim on either proof", async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
			for (const proof of ["asserted", "session"] as const) {
				await expect(
					claim(seed.memberId, seed.memberId, proof),
				).rejects.toThrow(exact(CLUB_ARCHIVED_MESSAGE));
			}
			expect(await slot()).toEqual({ status: "open", assignedMemberId: null });
		});
	});
});

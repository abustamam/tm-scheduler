/**
 * The TMOD contact gate, from the VIEWER's side (#1343).
 *
 * `loadTmodPanelData` grants the contact roster only when the signed-in
 * viewer's own active membership IS the meeting's Toastmaster. A viewer whose
 * only membership in the club is inactive or former is not the Toastmaster, so
 * they get names and no contact, even though the caller asserts the
 * Toastmaster's member id. A Toastmaster whose own membership has lapsed gets
 * nothing at all. `meetings-contact-gate.guard.test.ts` pins the call's source
 * shape; this runs it.
 *
 * protects=`contactAllowed` requires the viewer's own membership to BE the
 *   Toastmaster's, so a viewer with a missing or other (inactive/former)
 *   membership receives no phone or email; a lapsed (inactive/former)
 *   Toastmaster gets `{ plan: [], roster: [] }`;
 * fails_when=`membership?.id === tmodMemberId` stops requiring a membership
 *   (a null membership passes), or the claimed-status check stops rejecting a
 *   lapsed Toastmaster;
 * no_claim=that `getActiveMembership` filters on active status, which
 *   `membership-resolution.integration.test.ts` ("null when the only membership
 *   is not active") pins directly; it is unobservable through this function.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	setMemberPhone,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadTmodPanelData } = await import("#/server/meetings-logic");

describe.skipIf(!hasTestDb)("loadTmodPanelData contact gate (#1343)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
		await setMemberPhone(seed.memberId, "+12025550101");
		await setMemberPhone(seed.adminMemberId, "+12025550102");
		// The admin member is the meeting's Toastmaster.
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Toastmaster of the Day",
				key: "toastmaster_of_the_day",
				category: "leadership",
				sortOrder: 1,
			})
			.returning({ id: roleDefinitions.id });
		if (!def) throw new Error("failed to insert TMOD role definition");
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: def.id,
			status: "confirmed",
			assignedMemberId: seed.adminMemberId,
		});
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("gives the Toastmaster's own session the contact roster (control)", async () => {
		const { roster } = await loadTmodPanelData({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
			sessionUserId: seed.adminUserId,
		});
		expect(roster.some((r) => r.phone !== null)).toBe(true);
	});

	for (const status of ["inactive", "former"] as const) {
		it(`withholds contact from a viewer whose only membership is ${status}`, async () => {
			await testDb
				.update(members)
				.set({ status })
				.where(eq(members.id, seed.memberId));

			const { plan, roster } = await loadTmodPanelData({
				meetingId: seed.meetingId,
				// The Toastmaster's id is asserted by the caller; the viewer is not them.
				memberId: seed.adminMemberId,
				sessionUserId: seed.memberUserId,
			});

			// Names still render (the ladder is granted on the claim) ...
			expect(plan).toBeDefined();
			expect(roster.length).toBeGreaterThan(0);
			// ... but no contact reaches a viewer without an active membership.
			expect(roster.every((r) => r.phone === null && r.email === null)).toBe(
				true,
			);
		});
	}

	for (const status of ["inactive", "former"] as const) {
		it(`gives a Toastmaster whose own membership is ${status} nothing`, async () => {
			await testDb
				.update(members)
				.set({ status })
				.where(eq(members.id, seed.adminMemberId));

			const result = await loadTmodPanelData({
				meetingId: seed.meetingId,
				memberId: seed.adminMemberId,
				sessionUserId: seed.adminUserId,
			});

			expect(result).toEqual({ plan: [], roster: [] });
		});
	}
});

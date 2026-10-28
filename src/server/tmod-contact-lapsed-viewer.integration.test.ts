/**
 * The TMOD contact gate, from the VIEWER's side (#1343).
 *
 * `loadTmodPanelData` grants the contact roster only when the signed-in
 * viewer's ACTIVE membership is the meeting's Toastmaster. A viewer whose only
 * membership in the club is inactive or former has none, so they get names and
 * no contact, even though the caller asserts the Toastmaster's member id.
 * `meetings-contact-gate.guard.test.ts` pins the call's source shape; this
 * runs it.
 *
 * protects=a viewer with only an inactive or former membership in the club
 *   receives no phone or email from `loadTmodPanelData`;
 * fails_when=a missing active membership (`getActiveMembership` null) passes the
 *   `contactAllowed` check, or `getActiveMembership` stops filtering on active;
 * no_claim=the honour-system claim step (the claimed member's own status), which
 *   `tmod-panel-data.integration.test.ts` covers.
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
});

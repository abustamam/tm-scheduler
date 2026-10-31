/**
 * #1442 AC 3, server level: what a signed-out (non-managing) reader of the
 * meeting payload can learn about who has NOT answered.
 *
 * Covers: `loadMeetingDetailForTest(…, { canManage: false })`, the loader the
 * public meeting page reads, plus `publicComingCount` over its output. It
 * proves the count is derivable from the payload and that nothing in it
 * identifies a member who is asked-but-unanswered or silent.
 * Does NOT cover: the browser round trip (credentials omit, seroval parse) or
 * the "N coming" line's rendering; the route is only reached through the
 * server function, which this calls below.
 *
 *   TEST_DATABASE_URL=… bunx vitest run src/server/meetings-public-coming-count.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { setPlanStatus } = await import("#/server/attendance-plan-logic");
const { loadMeetingSlots } = await import("#/server/meeting-slots-logic");
const { loadMeetingDetailForTest } = await import("#/server/meetings-logic");
const { buildPanelRoleMap, publicComingCount } = await import(
	"#/lib/attendance-panel"
);

describe.skipIf(!hasTestDb)("public coming count (#1442)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("gives N coming and no trace of a member who has not answered", async () => {
		await setPlanStatus(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "coming",
			actorMemberId: seed.memberId,
		});
		// The officer asked the admin member; they have not replied.
		await setPlanStatus(testDb, {
			memberId: seed.adminMemberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "reached_out",
			actorMemberId: seed.adminMemberId,
		});
		// A CONFIRMED role holder who has not answered: counted as coming through
		// their role (`resolveEffectiveRung`), and only through it.
		const personId = await seedPerson({ name: "Rita Holder" });
		const [holder] = await testDb
			.insert(members)
			.values({ clubId: seed.clubId, personId, name: "Rita Holder" })
			.returning({ id: members.id });
		if (!holder) throw new Error("Failed to insert member");
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: holder.id,
				status: "confirmed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, seed.slotId));
		const payload = await loadMeetingDetailForTest(seed.meetingId, {
			canManage: false,
		});
		// Anti-vacuity: the answerer must be there or "absent" proves nothing.
		expect(payload.answeredRungs).toEqual([
			{ memberId: seed.memberId, status: "coming" },
		]);
		expect(payload.plan).toEqual([]);
		// The role map the meeting route builds, from the slots the page loads.
		const roles = buildPanelRoleMap(await loadMeetingSlots(seed.meetingId));
		expect(roles[holder.id]?.confirmed).toBe(true);
		// One stored Coming plus one confirmed holder with no answer.
		expect(publicComingCount(payload.answeredRungs, roles)).toBe(2);
		// The non-answerer's id appears nowhere in the rung data.
		expect(JSON.stringify(payload.answeredRungs)).not.toContain(
			seed.adminMemberId,
		);
	});
});

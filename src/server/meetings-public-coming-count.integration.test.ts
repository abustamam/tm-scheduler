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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { setPlanStatus } = await import("#/server/attendance-plan-logic");
const { loadMeetingDetailForTest } = await import("#/server/meetings-logic");
const { publicComingCount } = await import("#/lib/attendance-panel");

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
		const payload = await loadMeetingDetailForTest(seed.meetingId, {
			canManage: false,
		});
		// Anti-vacuity: the answerer must be there or "absent" proves nothing.
		expect(payload.answeredRungs).toEqual([
			{ memberId: seed.memberId, status: "coming" },
		]);
		expect(payload.plan).toEqual([]);
		// Role holders' slots ride the payload too; with nobody confirmed the
		// count is exactly the one stored Coming.
		const roles: Record<string, { confirmed: boolean }> = {};
		expect(publicComingCount(payload.answeredRungs, roles)).toBe(1);
		// The non-answerer's id appears nowhere in the rung data.
		expect(JSON.stringify(payload.answeredRungs)).not.toContain(
			seed.adminMemberId,
		);
		expect(JSON.stringify(payload.plan)).not.toContain(seed.adminMemberId);
	});
});

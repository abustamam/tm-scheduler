import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog } from "#/db/schema";
import { logActivity } from "#/server/activity";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

describe.skipIf(!hasTestDb)("logActivity", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("inserts a row with action, target, and detail", async () => {
		await logActivity(testDb, {
			clubId: seed.clubId,
			actorMemberId: null,
			action: "claim",
			targetType: "slot",
			targetId: seed.slotId,
			detail: { before: null, after: "claimed" },
		});
		const rows = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.clubId, seed.clubId));
		expect(rows).toHaveLength(1);
		expect(rows[0].action).toBe("claim");
		expect(rows[0].targetId).toBe(seed.slotId);
		expect(rows[0].detail).toEqual({ before: null, after: "claimed" });
	});
});

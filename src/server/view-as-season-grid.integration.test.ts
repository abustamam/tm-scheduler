/**
 * "Preview as member" (#1113) on the season grid, asserted on the PAYLOAD, not
 * the DOM: the outreach set must be absent from what `getSeasonGrid` returns.
 * The wrapper's decision is `seasonGridIncludesOutreach`, fed to `loadSeasonGrid`
 * exactly as `season-grid.ts` does it.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetingAttendancePlan, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("season grid in a preview", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
			.where(eq(meetings.id, seed.meetingId));
		await testDb.insert(meetingAttendancePlan).values({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			status: "reached_out",
		});
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function grid(isAdmin: boolean, asMember: boolean) {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		const { seasonGridIncludesOutreach } = await import(
			"#/server/view-as-logic"
		);
		return loadSeasonGrid({
			clubId: seed.clubId,
			count: 8,
			includeContact: true,
			includeOutreach: seasonGridIncludesOutreach({ isAdmin, asMember }),
		});
	}

	it("an admin outside a preview gets the outreach set (control)", async () => {
		expect((await grid(true, false)).contacted).toContainEqual({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
		});
	});

	it("an admin in a preview gets no outreach set", async () => {
		expect((await grid(true, true)).contacted).toEqual([]);
	});
});

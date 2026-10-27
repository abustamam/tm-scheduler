/**
 * #1328: ending a membership leaves a readable activity record, and the
 * activity log's member filter still lists the former member.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, officerTerms, roleSlots } from "#/db/schema";
import { formatActivity } from "#/lib/activity-format";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("former members in history (#1328)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("End records the closed offices and reads as 'ended <name>'s membership'", async () => {
		const { applySetMemberStatus } = await import("#/server/members-logic");
		const { loadActivity } = await import("#/server/activity-feed-logic");
		const personId = await seedPerson({ name: "Ending Edna" });
		const [m] = await testDb
			.insert(members)
			.values({ clubId: seed.clubId, personId, name: "Ending Edna" })
			.returning({ id: members.id });
		await testDb.insert(officerTerms).values({
			membershipId: m.id,
			position: "treasurer",
			termStart: new Date("2020-01-01"),
		});

		await applySetMemberStatus({
			clubId: seed.clubId,
			memberId: m.id,
			status: "former",
			actorMemberId: seed.adminMemberId,
		});

		const feed = await loadActivity({ clubId: seed.clubId });
		const summaries = feed
			.filter(
				(e) => e.action === "member_edit" && e.subjectName === "Ending Edna",
			)
			.map((e) => formatActivity(e).summary);
		expect(summaries).toEqual(["ended Ending Edna's membership"]);
		const { db } = await import("#/db");
		const { activityLog } = await import("#/db/schema");
		const [row] = await db
			.select()
			.from(activityLog)
			.where(eq(activityLog.targetId, m.id));
		expect(row.detail).toMatchObject({
			change: "membership_ended",
			closedOfficerPositions: ["treasurer"],
			releasedSlots: 0,
		});
		// Nothing was demoted, so no role is claimed released.
		expect(row.detail).not.toHaveProperty("releasedClubRole");
	});

	it("End counts the upcoming roles it released and names a demoted club role", async () => {
		const { applySetMemberStatus } = await import("#/server/members-logic");
		const personId = await seedPerson({ name: "Holding Hal" });
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId,
				name: "Holding Hal",
				clubRole: "admin",
			})
			.returning({ id: members.id });
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: m.id, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));

		await applySetMemberStatus({
			clubId: seed.clubId,
			memberId: m.id,
			status: "former",
			actorMemberId: seed.adminMemberId,
		});

		const { db } = await import("#/db");
		const { activityLog } = await import("#/db/schema");
		const rows = await db
			.select()
			.from(activityLog)
			.where(eq(activityLog.targetId, m.id));
		expect(rows.map((r) => r.detail)).toContainEqual(
			expect.objectContaining({
				change: "membership_ended",
				releasedSlots: 1,
				releasedClubRole: "admin",
			}),
		);
	});

	it("the activity member filter lists a former member, marked by status", async () => {
		const { loadActivityActorOptions } = await import(
			"#/server/activity-actors-logic"
		);
		const personId = await seedPerson({ name: "Gone Gus" });
		await testDb.insert(members).values({
			clubId: seed.clubId,
			personId,
			name: "Gone Gus",
			status: "former",
		});
		const opts = await loadActivityActorOptions(seed.clubId);
		expect(opts).toContainEqual(
			expect.objectContaining({ name: "Gone Gus", status: "former" }),
		);
		// Names and status only: no contact leaves this reader.
		expect(Object.keys(opts[0] ?? {}).sort()).toEqual(["id", "name", "status"]);
	});
});

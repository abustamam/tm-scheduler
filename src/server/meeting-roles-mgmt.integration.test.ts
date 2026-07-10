/**
 * DB-backed tests for adding/removing arbitrary roles on a meeting and syncing
 * the template onto upcoming meetings (#143). Tests the plain logic fns directly
 * (`#/db` redirected to the test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-roles-mgmt.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyAddRoleSlot,
	applyRemoveRoleSlot,
	applyTemplateSyncToUpcomingMeetings,
} = await import("./slots-logic");

/** Insert a role definition on the seeded club; return its id. */
async function addRole(
	clubId: string,
	o: {
		name: string;
		category?: "leadership" | "speaker" | "evaluator" | "functionary";
		defaultCount?: number;
		sortOrder?: number;
		isSpeakerRole?: boolean;
	},
): Promise<string> {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: o.name,
			category: o.category ?? "functionary",
			defaultCount: o.defaultCount ?? 1,
			sortOrder: o.sortOrder ?? 50,
			isSpeakerRole: o.isSpeakerRole ?? false,
		})
		.returning({ id: roleDefinitions.id });
	return row.id;
}

async function slotsFor(meetingId: string, roleId: string) {
	return testDb
		.select({ id: roleSlots.id, slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.roleDefinitionId, roleId),
			),
		)
		.orderBy(roleSlots.slotIndex);
}

describe.skipIf(!hasTestDb)("meeting role management (#143)", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("applyAddRoleSlot adds an open slot", async () => {
		const roleId = await addRole(club.clubId, { name: "Vote Counter" });
		await applyAddRoleSlot({
			meetingId: club.meetingId,
			roleDefinitionId: roleId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, roleId)).toHaveLength(1);
	});

	it("applyAddRoleSlot allows a duplicate at the next slotIndex", async () => {
		const roleId = await addRole(club.clubId, { name: "Vote Counter" });
		await applyAddRoleSlot({
			meetingId: club.meetingId,
			roleDefinitionId: roleId,
			actorMemberId: club.adminMemberId,
		});
		await applyAddRoleSlot({
			meetingId: club.meetingId,
			roleDefinitionId: roleId,
			actorMemberId: club.adminMemberId,
		});
		const rows = await slotsFor(club.meetingId, roleId);
		expect(rows.map((r) => r.slotIndex)).toEqual([0, 1]);
	});

	it("applyAddRoleSlot rejects a role from a different club", async () => {
		const other = await seedClub();
		try {
			await expect(
				applyAddRoleSlot({
					meetingId: club.meetingId,
					roleDefinitionId: other.roleDefinitionId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(/not found for this club/i);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("applyAddRoleSlot rejects the speaker role", async () => {
		const spk = await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
		});
		await expect(
			applyAddRoleSlot({
				meetingId: club.meetingId,
				roleDefinitionId: spk,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/speaker controls/i);
	});
});

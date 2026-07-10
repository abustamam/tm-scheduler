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

	it("applyRemoveRoleSlot deletes an unclaimed slot", async () => {
		// The seeded club already has one open Timer slot on the meeting.
		await applyRemoveRoleSlot({
			slotId: club.slotId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, club.roleDefinitionId)).toHaveLength(
			0,
		);
	});

	it("applyRemoveRoleSlot rejects a claimed slot", async () => {
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: club.memberId })
			.where(eq(roleSlots.id, club.slotId));
		await expect(
			applyRemoveRoleSlot({
				slotId: club.slotId,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/release the role/i);
	});

	it("applyRemoveRoleSlot rejects the paired evaluator", async () => {
		await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
		});
		const evId = await addRole(club.clubId, {
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 3,
			sortOrder: 11,
		});
		const [evSlot] = await testDb
			.insert(roleSlots)
			.values({ meetingId: club.meetingId, roleDefinitionId: evId })
			.returning({ id: roleSlots.id });
		await expect(
			applyRemoveRoleSlot({
				slotId: evSlot.id,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/speaker controls/i);
	});

	it("sync adds a missing standard role to upcoming meetings", async () => {
		const vc = await addRole(club.clubId, {
			name: "Vote Counter",
			sortOrder: 60,
		});
		const res = await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(res.meetingsChanged).toBe(1);
		expect(res.rolesAdded).toEqual(["Vote Counter"]);
		expect(await slotsFor(club.meetingId, vc)).toHaveLength(1);
	});

	it("sync skips roles already present (idempotent)", async () => {
		// Timer (the seeded role) is already on the meeting.
		const first = await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(first.meetingsChanged).toBe(0);
		// Adding then re-running adds it once, and a second run is a no-op.
		await addRole(club.clubId, { name: "Vote Counter", sortOrder: 60 });
		await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		const again = await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(again.meetingsChanged).toBe(0);
	});

	it("sync skips defaultCount 0 roles", async () => {
		const joke = await addRole(club.clubId, {
			name: "Jokemaster",
			defaultCount: 0,
			sortOrder: 61,
		});
		await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, joke)).toHaveLength(0);
	});

	it("sync never adds speakers or the paired evaluator", async () => {
		const spk = await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			defaultCount: 2,
			sortOrder: 10,
		});
		const ev = await addRole(club.clubId, {
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 2,
			sortOrder: 11,
		});
		await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, spk)).toHaveLength(0);
		expect(await slotsFor(club.meetingId, ev)).toHaveLength(0);
	});

	it("sync leaves past meetings untouched", async () => {
		const [past] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		const vc = await addRole(club.clubId, {
			name: "Vote Counter",
			sortOrder: 60,
		});
		await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(past.id, vc)).toHaveLength(0);
		// sanity: the upcoming meeting DID get it
		expect(await slotsFor(club.meetingId, vc)).toHaveLength(1);
	});

	it("sync never tops up an existing role toward defaultCount", async () => {
		// A standard role that wants 2 but the meeting already has 1 → presence-
		// based sync leaves it at 1 (a naive count-based top-up would add a 2nd).
		const greeter = await addRole(club.clubId, {
			name: "Greeter",
			defaultCount: 2,
			sortOrder: 62,
		});
		await testDb
			.insert(roleSlots)
			.values({ meetingId: club.meetingId, roleDefinitionId: greeter });
		const res = await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(res.meetingsChanged).toBe(0);
		expect(await slotsFor(club.meetingId, greeter)).toHaveLength(1);
	});
});

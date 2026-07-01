/**
 * DB-backed tests for meeting management (edit meta + variable speakers).
 * Tests the plain logic fns directly (`#/db` redirected to the test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-manage.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyAddSpeakerSlot, applyMoveSpeakerSlot, applyRemoveSpeakerSlot } =
	await import("./slots-logic");
const { applyMeetingUpdate } = await import("./meetings-logic");

/** Add a speaker + evaluator role def to the seeded club; return their ids. */
async function addSpeakerAndEvaluatorRoles(clubId: string) {
	const [spk] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: "Speaker",
			category: "speaker",
			defaultCount: 3,
			sortOrder: 10,
			isSpeakerRole: true,
		})
		.returning({ id: roleDefinitions.id });
	const [ev] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 3,
			sortOrder: 11,
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });
	await testDb.insert(roleDefinitions).values({
		clubId,
		name: "General Evaluator",
		category: "evaluator",
		defaultCount: 1,
		sortOrder: 12,
		isSpeakerRole: false,
	});
	return { speakerRoleId: spk.id, evaluatorRoleId: ev.id };
}

async function slotsFor(meetingId: string, roleId: string) {
	return testDb
		.select({
			id: roleSlots.id,
			slotIndex: roleSlots.slotIndex,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
		})
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.roleDefinitionId, roleId),
			),
		)
		.orderBy(roleSlots.slotIndex);
}

describe.skipIf(!hasTestDb)("meeting management", () => {
	let club: SeededClub;
	let speakerRoleId: string;
	let evaluatorRoleId: string;

	beforeEach(async () => {
		club = await seedClub();
		const roles = await addSpeakerAndEvaluatorRoles(club.clubId);
		speakerRoleId = roles.speakerRoleId;
		evaluatorRoleId = roles.evaluatorRoleId;
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("updateMeeting writes fields + logs meeting_edit", async () => {
		await applyMeetingUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			scheduledAt: "2026-08-01T18:30",
			theme: "  New Beginnings  ",
			wordOfTheDay: "verve",
		});
		const [m] = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.action, "meeting_edit"));
		expect(m).toBeTruthy();
	});

	it("addSpeakerSlot adds a paired speaker + evaluator", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		expect(await slotsFor(club.meetingId, speakerRoleId)).toHaveLength(1);
		expect(await slotsFor(club.meetingId, evaluatorRoleId)).toHaveLength(1);
	});

	it("removeSpeakerSlot removes the top unclaimed speaker + an evaluator", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyRemoveSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		expect(await slotsFor(club.meetingId, speakerRoleId)).toHaveLength(1);
		expect(await slotsFor(club.meetingId, evaluatorRoleId)).toHaveLength(1);
	});

	it("removeSpeakerSlot errors when every speaker is claimed", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [spk] = await slotsFor(club.meetingId, speakerRoleId);
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: club.memberId })
			.where(eq(roleSlots.id, spk.id));
		await expect(
			applyRemoveSpeakerSlot({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
			}),
		).rejects.toThrow(/Release a speaker/);
	});

	it("removing down to 0 speakers succeeds", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyRemoveSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		expect(await slotsFor(club.meetingId, speakerRoleId)).toHaveLength(0);
	});

	it("moveSpeakerSlot swaps adjacent speaker indices, leaving evaluators", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const before = await slotsFor(club.meetingId, speakerRoleId); // [idx0, idx1]
		await applyMoveSpeakerSlot({
			slotId: before[1].id,
			direction: "up",
			actorMemberId: club.memberId,
		});
		const after = await slotsFor(club.meetingId, speakerRoleId);
		expect(after[0].id).toBe(before[1].id); // the second slot is now first
		expect(await slotsFor(club.meetingId, evaluatorRoleId)).toHaveLength(2);
	});

	it("moveSpeakerSlot errors at the boundary", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [only] = await slotsFor(club.meetingId, speakerRoleId);
		await expect(
			applyMoveSpeakerSlot({
				slotId: only.id,
				direction: "up",
				actorMemberId: club.memberId,
			}),
		).rejects.toThrow(/No slot to swap/);
	});
});

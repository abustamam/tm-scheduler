/**
 * The two digital-voting switches (#770) as WRITES: what flipping each one
 * does to votes already open, and what it records. The gates themselves — that
 * an off meeting refuses to open, cast or join — are in
 * `voting.integration.test.ts`, which flips the columns directly so each gate
 * is shown to hold without a force-close having run first.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	meetings,
	meetingVoteSessions,
	meetingVotes,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { castVote, openVote } = await import("#/server/voting-logic");
const { applyMeetingDigitalVoting } = await import("#/server/meetings-logic");
const { applyClubAgendaSettingsUpdate, getClubAgendaSettings } = await import(
	"#/server/clubs-logic"
);

async function seedSpeaker(seed: SeededClub, meetingId: string) {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: seed.clubId,
			name: `Speaker ${randomUUID()}`,
			category: "speaker",
			sortOrder: 99,
		})
		.returning({ id: roleDefinitions.id });
	await testDb.insert(roleSlots).values({
		meetingId,
		roleDefinitionId: def.id,
		slotIndex: 0,
		assignedMemberId: seed.adminMemberId,
	});
}

const openBestSpeaker = (seed: SeededClub, meetingId: string) =>
	openVote({
		meetingId,
		category: "best_speaker",
		actorMemberId: seed.adminMemberId,
		clubId: seed.clubId,
	});

async function bestSpeakerSession(meetingId: string) {
	const [row] = await testDb
		.select({
			id: meetingVoteSessions.id,
			closedAt: meetingVoteSessions.closedAt,
		})
		.from(meetingVoteSessions)
		.where(
			and(
				eq(meetingVoteSessions.meetingId, meetingId),
				eq(meetingVoteSessions.category, "best_speaker"),
			),
		);
	return row;
}

describe.skipIf(!hasTestDb)("the meeting switch (#770)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		await seedSpeaker(seed, seed.meetingId);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("switching off closes the open vote in the same call, and logs it", async () => {
		await openBestSpeaker(seed, seed.meetingId);
		await applyMeetingDigitalVoting({
			meetingId: seed.meetingId,
			disabled: true,
			actorMemberId: seed.adminMemberId,
		});

		const [meeting] = await testDb
			.select({ disabled: meetings.digitalVotingDisabled })
			.from(meetings)
			.where(eq(meetings.id, seed.meetingId));
		expect(meeting.disabled).toBe(true);
		expect((await bestSpeakerSession(seed.meetingId)).closedAt).not.toBeNull();

		const logged = await testDb
			.select({ action: activityLog.action, detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "meeting_edit"),
				),
			);
		expect(logged.map((l) => l.detail)).toContainEqual({
			change: "digital_voting_disabled",
		});
	});

	it("switching back on keeps the votes, and reopening reuses the same session", async () => {
		await openBestSpeaker(seed, seed.meetingId);
		await castVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "member", id: seed.adminMemberId },
		});
		const before = await bestSpeakerSession(seed.meetingId);

		await applyMeetingDigitalVoting({
			meetingId: seed.meetingId,
			disabled: true,
			actorMemberId: seed.adminMemberId,
		});
		await applyMeetingDigitalVoting({
			meetingId: seed.meetingId,
			disabled: false,
			actorMemberId: seed.adminMemberId,
		});
		await openBestSpeaker(seed, seed.meetingId);

		const after = await bestSpeakerSession(seed.meetingId);
		expect(after.id).toBe(before.id);
		expect(after.closedAt).toBeNull();
		const votes = await testDb
			.select({ id: meetingVotes.id })
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, after.id));
		expect(votes).toHaveLength(1);

		const logged = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "meeting_edit"),
				),
			);
		expect(logged.map((l) => l.detail)).toContainEqual({
			change: "digital_voting_enabled",
		});
	});

	it("switching off a meeting with no vote open creates no session", async () => {
		await applyMeetingDigitalVoting({
			meetingId: seed.meetingId,
			disabled: true,
			actorMemberId: seed.adminMemberId,
		});
		expect(await bestSpeakerSession(seed.meetingId)).toBeUndefined();
	});

	it("refuses a meeting that does not exist", async () => {
		await expect(
			applyMeetingDigitalVoting({
				meetingId: randomUUID(),
				disabled: true,
				actorMemberId: null,
			}),
		).rejects.toThrow("Meeting not found.");
	});
});

describe.skipIf(!hasTestDb)("the club switch (#770)", () => {
	let seed: SeededClub;
	let other: SeededClub;
	let secondMeetingId: string;

	const settings = (clubId: string, digitalVotingEnabled?: boolean) => ({
		clubId,
		geIntroducesFunctionaries: false,
		tableTopicsMinSeconds: null,
		tableTopicsMaxSeconds: null,
		...(digitalVotingEnabled === undefined ? {} : { digitalVotingEnabled }),
	});

	beforeEach(async () => {
		seed = await seedClub();
		other = await seedClub();
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
			})
			.returning({ id: meetings.id });
		secondMeetingId = m.id;
		await seedSpeaker(seed, seed.meetingId);
		await seedSpeaker(seed, secondMeetingId);
		await seedSpeaker(other, other.meetingId);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	it("defaults a club to on", async () => {
		expect(
			(await getClubAgendaSettings(seed.clubId)).digitalVotingEnabled,
		).toBe(true);
	});

	it("switching off closes the open votes in EVERY meeting of that club, and no other club's", async () => {
		await openBestSpeaker(seed, seed.meetingId);
		await openBestSpeaker(seed, secondMeetingId);
		await openBestSpeaker(other, other.meetingId);

		await applyClubAgendaSettingsUpdate(settings(seed.clubId, false));

		const [club] = await testDb
			.select({ on: clubs.digitalVotingEnabled })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		expect(club.on).toBe(false);
		expect((await bestSpeakerSession(seed.meetingId)).closedAt).not.toBeNull();
		expect((await bestSpeakerSession(secondMeetingId)).closedAt).not.toBeNull();
		expect((await bestSpeakerSession(other.meetingId)).closedAt).toBeNull();
	});

	it("a save that does not mention the switch leaves it alone (a tab from before #770)", async () => {
		await applyClubAgendaSettingsUpdate(settings(seed.clubId, false));
		await applyClubAgendaSettingsUpdate(settings(seed.clubId));
		expect(
			(await getClubAgendaSettings(seed.clubId)).digitalVotingEnabled,
		).toBe(false);
	});
});

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
import {
	activityLog,
	clubs,
	meetings,
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

const { applyAddSpeakerSlot, applyMoveSpeakerSlot, applyRemoveSpeakerSlot } =
	await import("./slots-logic");
const { applyMeetingUpdate, applyCreateMeeting } = await import(
	"./meetings-logic"
);

async function meetingRow(meetingId: string) {
	const [m] = await testDb
		.select({
			id: meetings.id,
			lengthMinutes: meetings.lengthMinutes,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId));
	return m;
}

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
			evaluatesSlotId: roleSlots.evaluatesSlotId,
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

	it("createMeeting copies the club default length onto the meeting", async () => {
		// Set a non-default club length to prove it's copied (not hardcoded 90).
		await testDb
			.update(clubs)
			.set({ defaultMeetingMinutes: 60 })
			.where(eq(clubs.id, club.clubId));

		const { meetingId } = await applyCreateMeeting({
			clubId: club.clubId,
			scheduledAt: "2026-09-01T18:30",
		});

		expect((await meetingRow(meetingId)).lengthMinutes).toBe(60);

		// Changing the club default later must NOT move the existing meeting.
		await testDb
			.update(clubs)
			.set({ defaultMeetingMinutes: 120 })
			.where(eq(clubs.id, club.clubId));
		expect((await meetingRow(meetingId)).lengthMinutes).toBe(60);
	});

	it("updateMeeting persists a per-meeting length override", async () => {
		await applyMeetingUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			scheduledAt: "2026-08-01T18:30",
			lengthMinutes: 75,
		});
		expect((await meetingRow(club.meetingId)).lengthMinutes).toBe(75);
	});

	it("updateMeeting leaves length unchanged when omitted", async () => {
		await testDb
			.update(meetings)
			.set({ lengthMinutes: 45 })
			.where(eq(meetings.id, club.meetingId));
		await applyMeetingUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			scheduledAt: "2026-08-01T18:30",
		});
		expect((await meetingRow(club.meetingId)).lengthMinutes).toBe(45);
	});

	it("addSpeakerSlot adds a paired speaker + evaluator", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		expect(await slotsFor(club.meetingId, speakerRoleId)).toHaveLength(1);
		expect(await slotsFor(club.meetingId, evaluatorRoleId)).toHaveLength(1);
	});

	/**
	 * #512: the pair was always created here, in one transaction, but the link
	 * was never written — so `evaluates_slot_id` was NULL on every meeting made
	 * through the app and five readers of it silently did nothing (the run
	 * sheet's "Evaluates {speaker}" branch, the speaker intro, `orderEvaluators`,
	 * the member activity dashboard's `evaluatorName`, and `agenda.ts`).
	 *
	 * Asserted against the speaker's actual id rather than just non-null: a bare
	 * non-null check would pass if the evaluator pointed at the wrong slot.
	 */
	it("addSpeakerSlot links the evaluator to the speaker it evaluates (#512)", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [speaker] = await slotsFor(club.meetingId, speakerRoleId);
		const [evaluator] = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(evaluator.evaluatesSlotId).toBe(speaker.id);
		// The speaker is the target, never itself a source.
		expect(speaker.evaluatesSlotId).toBeNull();
	});

	/**
	 * The dominant path (#512). Speaker and Evaluator both default to a count of
	 * 3, so almost every slot in the app is created here by the club template,
	 * not by the "+ Add speaker" button — a fix that covered only the button
	 * would leave most meetings unlinked.
	 *
	 * Positional pairing is sound at creation specifically because
	 * `generateSlotRows` has just emitted contiguous 0..n-1 indices per role in
	 * one insert. It is NOT sound later, which is why the link is persisted here
	 * rather than inferred on read.
	 */
	it("createMeeting links each template evaluator to its speaker (#512)", async () => {
		const { meetingId } = await applyCreateMeeting({
			clubId: club.clubId,
			scheduledAt: "2026-09-08T18:30",
		});
		const speakers = await slotsFor(meetingId, speakerRoleId);
		const evaluators = await slotsFor(meetingId, evaluatorRoleId);
		expect(speakers.length).toBeGreaterThan(1);
		expect(evaluators).toHaveLength(speakers.length);

		// Every evaluator is linked, one-to-one, to the speaker at its own index.
		expect(evaluators.every((e) => e.evaluatesSlotId !== null)).toBe(true);
		const speakerIdByIndex = new Map(speakers.map((s) => [s.slotIndex, s.id]));
		for (const evaluator of evaluators) {
			expect(evaluator.evaluatesSlotId).toBe(
				speakerIdByIndex.get(evaluator.slotIndex),
			);
		}
		expect(new Set(evaluators.map((e) => e.evaluatesSlotId)).size).toBe(
			evaluators.length,
		);
	});

	/**
	 * The regression that a single-speaker test cannot see: every evaluator
	 * pointing at the FIRST speaker would satisfy the test above. Pairing has to
	 * be one-to-one, in creation order.
	 */
	it("each added speaker gets its own evaluator, not a shared one (#512)", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		const evaluators = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(speakers).toHaveLength(2);
		expect(evaluators).toHaveLength(2);
		// Two distinct targets, and together they cover exactly the two speakers.
		const targets = evaluators.map((e) => e.evaluatesSlotId);
		expect(new Set(targets).size).toBe(2);
		expect([...targets].sort()).toEqual(speakers.map((s) => s.id).sort());
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

	/**
	 * Removing a speaker must delete the evaluator paired to THAT speaker, not
	 * whichever evaluator happens to sit at the highest index (#512).
	 *
	 * The links are deliberately CROSSED here so the two rules disagree: the
	 * removable speaker is the high-index one, but its evaluator is the
	 * low-index one. Under the old index-based rule the wrong evaluator was
	 * destroyed and the removed speaker's own evaluator survived pointing at
	 * nothing — the FK is ON DELETE SET NULL, so nothing errors, it just
	 * silently goes wrong.
	 */
	it("removeSpeakerSlot deletes the speaker's OWN evaluator, not the top one (#512)", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		const evaluators = await slotsFor(club.meetingId, evaluatorRoleId);
		const [sp0, sp1] = speakers;
		const [ev0, ev1] = evaluators;
		// Cross them: ev0 -> sp1 (the one that will be removed), ev1 -> sp0.
		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: sp1.id })
			.where(eq(roleSlots.id, ev0.id));
		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: sp0.id })
			.where(eq(roleSlots.id, ev1.id));

		await applyRemoveSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});

		const speakersAfter = await slotsFor(club.meetingId, speakerRoleId);
		const evaluatorsAfter = await slotsFor(club.meetingId, evaluatorRoleId);
		// sp1 removed (top unclaimed speaker, unchanged behaviour)...
		expect(speakersAfter.map((s) => s.id)).toEqual([sp0.id]);
		// ...and ITS evaluator ev0 went with it, NOT the higher-indexed ev1.
		expect(evaluatorsAfter.map((e) => e.id)).toEqual([ev1.id]);
		// The survivor still points at a speaker that still exists.
		expect(evaluatorsAfter[0].evaluatesSlotId).toBe(sp0.id);
	});

	/**
	 * The exact state that proved the original bug: a claimed speaker and a
	 * claimed evaluator at mismatched positions. Removing used to silently
	 * orphan the claimed evaluator; it now refuses, consistent with "Release the
	 * role before removing it" elsewhere in this module.
	 */
	it("removeSpeakerSlot refuses when the paired evaluator is claimed (#512)", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [sp0] = await slotsFor(club.meetingId, speakerRoleId);
		const evaluators = await slotsFor(club.meetingId, evaluatorRoleId);
		// Speaker 1 claimed, so the removable speaker is Speaker 2 — whose own
		// evaluator is also claimed.
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: club.memberId })
			.where(eq(roleSlots.id, sp0.id));
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: club.memberId })
			.where(eq(roleSlots.id, evaluators[1].id));

		await expect(
			applyRemoveSpeakerSlot({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
			}),
		).rejects.toThrow(/Release the evaluator/);

		// Nothing was destroyed.
		expect(await slotsFor(club.meetingId, speakerRoleId)).toHaveLength(2);
		expect(await slotsFor(club.meetingId, evaluatorRoleId)).toHaveLength(2);
	});

	/**
	 * Pre-#512 meetings have no links at all. Removing must still work rather
	 * than refusing or removing nothing.
	 */
	it("removeSpeakerSlot falls back to index order when nothing is linked (#512)", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: null })
			.where(eq(roleSlots.meetingId, club.meetingId));

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

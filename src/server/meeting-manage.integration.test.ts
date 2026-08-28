/**
 * DB-backed tests for meeting management (edit meta + variable speakers).
 * Tests the plain logic fns directly (`#/db` redirected to the test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-manage.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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

const {
	applyAddSpeakerSlot,
	applyMoveEvaluatorSlot,
	applyMoveSpeakerSlot,
	applyRemoveSpeakerSlot,
} = await import("./slots-logic");
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
	 * Positional pairing is sound at creation because `generateSlotRows` has just
	 * emitted contiguous 0..n-1 indices per role in one insert, and it STAYS sound
	 * afterwards because `realignEvaluatorPairs` re-derives it inside every edit
	 * (see the healing test below). The link is still persisted rather than
	 * inferred on read, so the readers need no role resolution and a meeting
	 * predating the rule keeps its stored answer until its next edit.
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

	/**
	 * Positional pairing (Evaluator N ↔ Speaker N): moving a speaker keeps the
	 * evaluator lineup in place and RE-POINTS the links, so Evaluator 1 always
	 * evaluates whoever now speaks first. This deliberately replaces the old
	 * sticky-follows-the-person behaviour.
	 */
	it("moveSpeakerSlot swaps speakers and re-points evaluators positionally", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const before = await slotsFor(club.meetingId, speakerRoleId); // [idx0, idx1]
		const evBefore = await slotsFor(club.meetingId, evaluatorRoleId);
		await applyMoveSpeakerSlot({
			slotId: before[1].id,
			direction: "up",
			actorMemberId: club.memberId,
		});
		const after = await slotsFor(club.meetingId, speakerRoleId);
		expect(after[0].id).toBe(before[1].id); // the second slot is now first
		// Evaluator order unchanged, links now positional.
		const evAfter = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(evAfter.map((e) => e.id)).toEqual(evBefore.map((e) => e.id));
		expect(evAfter.map((e) => e.evaluatesSlotId)).toEqual(
			after.map((s) => s.id),
		);
	});

	it("moveEvaluatorSlot swaps adjacent evaluators and re-points links positionally", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		const evBefore = await slotsFor(club.meetingId, evaluatorRoleId);
		await applyMoveEvaluatorSlot({
			slotId: evBefore[1].id,
			direction: "up",
			actorMemberId: club.memberId,
		});
		const evAfter = await slotsFor(club.meetingId, evaluatorRoleId);
		// The second evaluator is now first...
		expect(evAfter.map((e) => e.id)).toEqual([evBefore[1].id, evBefore[0].id]);
		// ...and each evaluator evaluates the speaker at its own position.
		expect(evAfter.map((e) => e.evaluatesSlotId)).toEqual(
			speakers.map((s) => s.id),
		);
		// Speakers untouched.
		expect(
			(await slotsFor(club.meetingId, speakerRoleId)).map((s) => s.id),
		).toEqual(speakers.map((s) => s.id));
		// The reorder is attributed in the activity feed, against THIS meeting.
		// Scoped to the seeded club: vitest runs test files in parallel against one
		// shared `tm_test`, so an unscoped select over a shared table can pass off
		// another suite's in-flight row.
		const log = await testDb
			.select({ detail: activityLog.detail, targetId: activityLog.targetId })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.action, "meeting_edit"),
					eq(activityLog.clubId, club.clubId),
					eq(activityLog.targetId, club.meetingId),
				),
			);
		expect(
			log.some(
				(r) =>
					(r.detail as { change?: string })?.change === "evaluator_reordered",
			),
		).toBe(true);
	});

	/** The "down" arm (`ordered[pos + 1]`) — every other move test goes up, so
	 *  this is the only thing that fails if the two arms are transposed. */
	it("moveEvaluatorSlot moves down as well as up", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		const evBefore = await slotsFor(club.meetingId, evaluatorRoleId);
		await applyMoveEvaluatorSlot({
			slotId: evBefore[0].id,
			direction: "down",
			actorMemberId: club.memberId,
		});
		const evAfter = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(evAfter.map((e) => e.id)).toEqual([evBefore[1].id, evBefore[0].id]);
		expect(evAfter.map((e) => e.evaluatesSlotId)).toEqual(
			speakers.map((s) => s.id),
		);
	});

	/**
	 * The consequence the whole change turns on: reordering RE-POINTS a claimed
	 * evaluator rather than dragging their assignment along. Deliberate — the
	 * lineup position decides who evaluates whom — and worth pinning because the
	 * sibling `applyRemoveSpeakerSlot` takes the OPPOSITE stance ("never destroy an
	 * assignment"), so a future reader may reasonably add a skip-claimed guard
	 * here and silently break the positional invariant for exactly the rows a real
	 * club has filled.
	 */
	it("re-points a CLAIMED evaluator's link, keeping its assignee", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const speakersBefore = await slotsFor(club.meetingId, speakerRoleId);
		const [ev0, ev1] = await slotsFor(club.meetingId, evaluatorRoleId);
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: club.memberId })
			.where(inArray(roleSlots.id, [ev0.id, ev1.id]));

		await applyMoveSpeakerSlot({
			slotId: speakersBefore[1].id,
			direction: "up",
			actorMemberId: club.memberId,
		});

		const speakersAfter = await slotsFor(club.meetingId, speakerRoleId);
		const evAfter = await slotsFor(club.meetingId, evaluatorRoleId);
		// Evaluator 1 is still Evaluator 1, still held by the same member...
		expect(evAfter.map((e) => e.id)).toEqual([ev0.id, ev1.id]);
		expect(evAfter.every((e) => e.assignedMemberId === club.memberId)).toBe(
			true,
		);
		expect(evAfter.every((e) => e.status === "claimed")).toBe(true);
		// ...and now evaluates whoever speaks in that position.
		expect(evAfter.map((e) => e.evaluatesSlotId)).toEqual(
			speakersAfter.map((s) => s.id),
		);
		expect(speakersAfter[0].id).toBe(speakersBefore[1].id);
	});

	it("both move fns reject an unknown slot id, per kind", async () => {
		await expect(
			applyMoveEvaluatorSlot({
				slotId: randomUUID(),
				direction: "up",
				actorMemberId: club.memberId,
			}),
		).rejects.toThrow(/Evaluator slot not found/);
		await expect(
			applyMoveSpeakerSlot({
				slotId: randomUUID(),
				direction: "up",
				actorMemberId: club.memberId,
			}),
		).rejects.toThrow(/Speaker slot not found/);
	});

	/**
	 * Speaker-side compaction. The evaluator half is pinned by the remove test
	 * above; without this the speaker `slotIndex` update inside
	 * `realignEvaluatorPairs` could be deleted with the whole suite green, and gap
	 * numbering means the cards read "Speaker 1, Speaker 3".
	 */
	it("compacts a gap in the SPEAKER numbering on the next edit", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		// Punch a hole: indices become [0, 5].
		await testDb
			.update(roleSlots)
			.set({ slotIndex: 5 })
			.where(eq(roleSlots.id, speakers[1].id));

		await applyMoveEvaluatorSlot({
			slotId: (await slotsFor(club.meetingId, evaluatorRoleId))[1].id,
			direction: "up",
			actorMemberId: club.memberId,
		});

		const after = await slotsFor(club.meetingId, speakerRoleId);
		expect(after.map((s) => s.slotIndex)).toEqual([0, 1]);
		expect(after.map((s) => s.id)).toEqual(speakers.map((s) => s.id));
	});

	/**
	 * A club with a Speaker role and NO evaluator-category role at all (not merely
	 * a disabled one — `clubRoles` resolves a disabled role's id fine). Both early
	 * arms of `realignEvaluatorPairs` run: the single-role id list, and the return
	 * before the evaluator loop.
	 */
	it("realigns speaker numbering for a club with no evaluator role", async () => {
		const bare = await seedClub();
		try {
			const [spk] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: bare.clubId,
					name: "Speaker",
					category: "speaker",
					defaultCount: 3,
					sortOrder: 10,
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			for (let i = 0; i < 3; i++) {
				await applyAddSpeakerSlot({
					meetingId: bare.meetingId,
					actorMemberId: bare.memberId,
				});
			}
			expect(await slotsFor(bare.meetingId, spk.id)).toHaveLength(3);

			await applyRemoveSpeakerSlot({
				meetingId: bare.meetingId,
				actorMemberId: bare.memberId,
			});

			const after = await slotsFor(bare.meetingId, spk.id);
			expect(after.map((s) => s.slotIndex)).toEqual([0, 1]);
			expect(after.every((s) => s.evaluatesSlotId === null)).toBe(true);
		} finally {
			await cleanup(bare.clubId, [bare.adminUserId, bare.memberUserId]);
		}
	});

	it("moveEvaluatorSlot errors at the boundary", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [onlyEv] = await slotsFor(club.meetingId, evaluatorRoleId);
		await expect(
			applyMoveEvaluatorSlot({
				slotId: onlyEv.id,
				direction: "up",
				actorMemberId: club.memberId,
			}),
		).rejects.toThrow(/No slot to swap/);
	});

	/**
	 * A meeting whose links pre-date positional pairing (or were crossed by an
	 * old speaker reorder) heals on its NEXT edit — no migration, no read-time
	 * derivation. Any add/remove/move realigns every link.
	 */
	it("crossed evaluator links heal positionally on the next edit", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [sp0, sp1] = await slotsFor(club.meetingId, speakerRoleId);
		const [ev0, ev1] = await slotsFor(club.meetingId, evaluatorRoleId);
		// Cross them, the state the old sticky pairing left behind.
		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: sp1.id })
			.where(eq(roleSlots.id, ev0.id));
		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: sp0.id })
			.where(eq(roleSlots.id, ev1.id));

		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});

		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		const evaluators = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(speakers).toHaveLength(3);
		expect(evaluators.map((e) => e.evaluatesSlotId)).toEqual(
			speakers.map((s) => s.id),
		);
	});

	/**
	 * Removing a speaker whose paired evaluator sits mid-list used to leave gap
	 * numbering ("Evaluator 1, Evaluator 3" — labels are slotIndex + 1). The
	 * realign compacts both roles' indexes and re-points the surviving links.
	 */
	it("removeSpeakerSlot compacts slot indexes and realigns links", async () => {
		for (let i = 0; i < 3; i++) {
			await applyAddSpeakerSlot({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
			});
		}
		const [sp0, sp1, sp2] = await slotsFor(club.meetingId, speakerRoleId);
		const [ev0, ev1, ev2] = await slotsFor(club.meetingId, evaluatorRoleId);
		// The removable speaker (top unclaimed = sp2) is paired to the MIDDLE
		// evaluator, so the deletion punches a hole in the evaluator numbering.
		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: sp2.id })
			.where(eq(roleSlots.id, ev1.id));
		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: sp1.id })
			.where(eq(roleSlots.id, ev2.id));

		await applyRemoveSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});

		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		const evaluators = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(speakers.map((s) => s.id)).toEqual([sp0.id, sp1.id]);
		expect(evaluators.map((e) => e.id)).toEqual([ev0.id, ev2.id]);
		// Dense numbering on both roles — no "Evaluator 3" without an "Evaluator 2".
		expect(speakers.map((s) => s.slotIndex)).toEqual([0, 1]);
		expect(evaluators.map((e) => e.slotIndex)).toEqual([0, 1]);
		// And positional links.
		expect(evaluators.map((e) => e.evaluatesSlotId)).toEqual([sp0.id, sp1.id]);
	});

	/**
	 * The activity label used to come from WHICH endpoint was called, not from the
	 * slot's role, so `moveEvaluatorSlot(<a speaker slot>)` swapped speakers and
	 * wrote "reordered evaluators" into the feed — an audit line describing
	 * something that did not happen. Both endpoints accept any slot id (the UI only
	 * ever sends the matching kind), so the check has to be server-side.
	 */
	it("moveEvaluatorSlot refuses a speaker slot", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		await expect(
			applyMoveEvaluatorSlot({
				slotId: speakers[1].id,
				direction: "up",
				actorMemberId: club.memberId,
			}),
		).rejects.toThrow(/not an evaluator slot/i);
		// Nothing moved.
		expect(
			(await slotsFor(club.meetingId, speakerRoleId)).map((s) => s.id),
		).toEqual(speakers.map((s) => s.id));
	});

	it("moveSpeakerSlot refuses an evaluator slot", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const evaluators = await slotsFor(club.meetingId, evaluatorRoleId);
		await expect(
			applyMoveSpeakerSlot({
				slotId: evaluators[1].id,
				direction: "up",
				actorMemberId: club.memberId,
			}),
		).rejects.toThrow(/not a speaker slot/i);
	});

	/** A slot of neither paired role (the club's Timer) is not reorderable through
	 *  either endpoint — and must not silently realign the paired links. */
	/**
	 * A club may flag MORE THAN ONE role as a speaker role (`isSpeakerRole` is a
	 * free checkbox on any club-invented role — a second contestant lineup, a
	 * "Debater"). The agenda renders ↑↓ on every speaker-flagged card, so the
	 * server must accept every speaker-flagged role here or the arrows the UI
	 * offers start erroring. Only the PAIRED lineup drives the evaluator links,
	 * so reordering the other one must leave them alone.
	 */
	it("moveSpeakerSlot accepts a second speaker-flagged role, without realigning", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [debaterDef] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				name: "Debater",
				category: "speaker",
				defaultCount: 2,
				// Higher sortOrder, so `pickSpeakerAndEvaluatorRoles` still picks the
				// club's standard Speaker as the paired lineup.
				sortOrder: 30,
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		const debaters = await testDb
			.insert(roleSlots)
			.values([
				{
					meetingId: club.meetingId,
					roleDefinitionId: debaterDef.id,
					slotIndex: 0,
				},
				{
					meetingId: club.meetingId,
					roleDefinitionId: debaterDef.id,
					slotIndex: 1,
				},
			])
			.returning({ id: roleSlots.id });
		// Null the paired evaluator's link so a stray realign would show up.
		const [ev0] = await slotsFor(club.meetingId, evaluatorRoleId);
		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: null })
			.where(eq(roleSlots.id, ev0.id));

		await applyMoveSpeakerSlot({
			slotId: debaters[1].id,
			direction: "up",
			actorMemberId: club.memberId,
		});

		// The debaters swapped...
		const after = await slotsFor(club.meetingId, debaterDef.id);
		expect(after.map((s) => s.id)).toEqual([debaters[1].id, debaters[0].id]);
		// ...and the paired lineup's links were not touched.
		const [evAfter] = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(evAfter.evaluatesSlotId).toBeNull();
	});

	/**
	 * One def can satisfy BOTH picks — `isSpeakerRole: true` with
	 * `category: "evaluator"` — because the speaker and evaluator heuristics are
	 * independent. Realign then read one lineup as both sides and pointed every
	 * slot at ITSELF, so every reader rendered "Speaker 2, evaluated by Speaker 2".
	 */
	it("never writes a self-referencing link when one role wins both picks", async () => {
		const dual = await seedClub();
		try {
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: dual.clubId,
					name: "Speaker",
					category: "evaluator",
					defaultCount: 3,
					sortOrder: 10,
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });

			await applyAddSpeakerSlot({
				meetingId: dual.meetingId,
				actorMemberId: dual.memberId,
			});
			await applyAddSpeakerSlot({
				meetingId: dual.meetingId,
				actorMemberId: dual.memberId,
			});

			const slots = await slotsFor(dual.meetingId, def.id);
			expect(slots.length).toBeGreaterThan(0);
			expect(slots.some((s) => s.evaluatesSlotId === s.id)).toBe(false);
		} finally {
			await cleanup(dual.clubId, [dual.adminUserId, dual.memberUserId]);
		}
	});

	/**
	 * Concurrency. Every slot mutation serializes on the MEETING row
	 * (`SELECT ... FOR UPDATE` inside its transaction), so two officers editing
	 * the same meeting at the same moment cannot interleave.
	 *
	 * Without that lock the reads that decide numbering and pairing ran on a
	 * pre-transaction snapshot: two concurrent adds each computed the same "next"
	 * index and both inserted it (no unique index stops them), and a reorder
	 * racing an add could compute evaluator targets from the pre-move order and
	 * commit them afterwards — links silently disagreeing with the visible order,
	 * which is the one thing this feature promises.
	 *
	 * Asserted through observable state rather than by spying on the lock: dense
	 * unique indices on both lineups and a one-to-one link set is exactly what an
	 * interleaved run cannot produce.
	 */
	it("serializes concurrent edits to one meeting", async () => {
		await Promise.all([
			applyAddSpeakerSlot({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
			}),
			applyAddSpeakerSlot({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
			}),
			applyAddSpeakerSlot({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
			}),
		]);
		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		const evaluators = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(speakers).toHaveLength(3);
		expect(evaluators).toHaveLength(3);
		expect(speakers.map((s) => s.slotIndex)).toEqual([0, 1, 2]);
		expect(evaluators.map((e) => e.slotIndex)).toEqual([0, 1, 2]);
		expect(evaluators.map((e) => e.evaluatesSlotId)).toEqual(
			speakers.map((s) => s.id),
		);
	});

	/** A reorder racing an add must not leave links describing the old order. */
	it("keeps links positional when a reorder races an add", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const before = await slotsFor(club.meetingId, speakerRoleId);
		await Promise.all([
			applyMoveSpeakerSlot({
				slotId: before[1].id,
				direction: "up",
				actorMemberId: club.memberId,
			}),
			applyAddSpeakerSlot({
				meetingId: club.meetingId,
				actorMemberId: club.memberId,
			}),
		]);
		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		const evaluators = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(speakers).toHaveLength(3);
		expect(speakers.map((s) => s.slotIndex)).toEqual([0, 1, 2]);
		// Whichever order the two edits landed in, the links describe the ORDER
		// THAT COMMITTED, position for position.
		expect(evaluators.map((e) => e.evaluatesSlotId)).toEqual(
			speakers.map((s) => s.id),
		);
	});

	/**
	 * Duplicate `slot_index` values can still exist in stored data (rows written
	 * before the lock landed, or a manual fix-up), so the realign must converge on
	 * dense, unique numbering with a one-to-one link set rather than leaving the
	 * tie in place.
	 */
	it("heals duplicate slot indexes into dense, one-to-one pairing", async () => {
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
		// Collapse both lineups onto index 0.
		await testDb
			.update(roleSlots)
			.set({ slotIndex: 0 })
			.where(inArray(roleSlots.id, [speakers[1].id, evaluators[1].id]));

		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});

		const spAfter = await slotsFor(club.meetingId, speakerRoleId);
		const evAfter = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(spAfter.map((s) => s.slotIndex)).toEqual([0, 1, 2]);
		expect(evAfter.map((e) => e.slotIndex)).toEqual([0, 1, 2]);
		// Every evaluator points at the speaker sharing its position, one-to-one.
		expect(evAfter.map((e) => e.evaluatesSlotId)).toEqual(
			spAfter.map((s) => s.id),
		);
		expect(new Set(evAfter.map((e) => e.evaluatesSlotId)).size).toBe(3);
	});

	it("neither move endpoint accepts a non-paired role's slot", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [timerDef] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				// Scoped to this run's freshly seeded club, so a plain name cannot
				// collide with a parallel test file's rows.
				name: "Timer",
				category: "functionary",
				defaultCount: 2,
				sortOrder: 20,
				isSpeakerRole: false,
			})
			.returning({ id: roleDefinitions.id });
		const timers = await testDb
			.insert(roleSlots)
			.values([
				{
					meetingId: club.meetingId,
					roleDefinitionId: timerDef.id,
					slotIndex: 0,
				},
				{
					meetingId: club.meetingId,
					roleDefinitionId: timerDef.id,
					slotIndex: 1,
				},
			])
			.returning({ id: roleSlots.id });
		// Cross the paired links so a stray realign would be visible.
		const [sp0] = await slotsFor(club.meetingId, speakerRoleId);
		const [ev0] = await slotsFor(club.meetingId, evaluatorRoleId);
		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: null })
			.where(eq(roleSlots.id, ev0.id));

		await expect(
			applyMoveSpeakerSlot({
				slotId: timers[1].id,
				direction: "up",
				actorMemberId: club.memberId,
			}),
		).rejects.toThrow(/not a speaker slot/i);

		// The stray realign did not run: the nulled link is still null.
		const [evAfter] = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(evAfter.evaluatesSlotId).toBeNull();
		expect(sp0.id).toBeTruthy();
	});

	/**
	 * A CLAIMED surplus evaluator loses its link too, and that is the deliberate
	 * stance rather than an oversight.
	 *
	 * With 3 evaluators and 2 speakers there is no third speech to evaluate, so
	 * the only alternatives are worse: keeping the old target puts two evaluators
	 * on one speaker (the card would read "Evaluates Michael" twice, breaking the
	 * one-to-one rule this whole change exists to establish), and refusing the
	 * edit would block routine agenda work on any count-mismatched meeting until
	 * someone releases a slot. The assignee keeps their slot and the card falls
	 * back to "Evaluates a speaker".
	 *
	 * Note this DIFFERS from `applyRemoveSpeakerSlot`, which throws rather than
	 * orphan a claimed evaluator — there, the orphaning is avoidable by refusing
	 * one optional action; here the mismatch already exists and every edit would
	 * be blocked.
	 */
	it("nulls a CLAIMED surplus evaluator's link, keeping the assignment", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [sp0] = await slotsFor(club.meetingId, speakerRoleId);
		// A third evaluator with no speaker of its own, claimed and pointing at the
		// one real speaker — the legacy shape.
		const [surplus] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: club.meetingId,
				roleDefinitionId: evaluatorRoleId,
				slotIndex: 1,
				status: "claimed",
				assignedMemberId: club.memberId,
				evaluatesSlotId: sp0.id,
			})
			.returning({ id: roleSlots.id });

		await applyMoveEvaluatorSlot({
			slotId: surplus.id,
			direction: "up",
			actorMemberId: club.memberId,
		});

		const evAfter = await slotsFor(club.meetingId, evaluatorRoleId);
		const surplusAfter = evAfter.find((e) => e.id === surplus.id);
		expect(surplusAfter).toBeTruthy();
		// The slot and its assignee survive...
		expect(surplusAfter?.assignedMemberId).toBe(club.memberId);
		expect(surplusAfter?.status).toBe("claimed");
		// ...and exactly one evaluator (the one in position 1) holds the link.
		expect(evAfter.filter((e) => e.evaluatesSlotId === sp0.id)).toHaveLength(1);
		expect(evAfter[0].evaluatesSlotId).toBe(sp0.id);
		expect(evAfter[1].evaluatesSlotId).toBeNull();
	});

	/** More evaluators than speakers: extras pair with nobody (null link). */
	it("realign leaves surplus evaluators unlinked", async () => {
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		const [extra] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: club.meetingId,
				roleDefinitionId: evaluatorRoleId,
				slotIndex: 1,
			})
			.returning({ id: roleSlots.id });

		await applyMoveEvaluatorSlot({
			slotId: extra.id,
			direction: "up",
			actorMemberId: club.memberId,
		});

		const speakers = await slotsFor(club.meetingId, speakerRoleId);
		const evaluators = await slotsFor(club.meetingId, evaluatorRoleId);
		expect(evaluators.map((e) => e.id)).toEqual([extra.id, expect.any(String)]);
		expect(evaluators[0].evaluatesSlotId).toBe(speakers[0].id);
		expect(evaluators[1].evaluatesSlotId).toBeNull();
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

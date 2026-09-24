/**
 * #840: "− speaker" against a claim of the very pair it chose.
 *
 * `applyRemoveSpeakerSlot` decides which Speaker and which Evaluator to delete
 * from a lineup read taken under the meeting lock. Claim writers never take that
 * lock (their only meeting access is the attendance FK's KEY SHARE, which NO KEY
 * UPDATE admits on purpose), so a claim can commit between that read and the
 * DELETE. An id-only DELETE parked on the claim's row lock re-matches `id =`
 * after the claim commits and removes the newly claimed slot.
 *
 * The race cases race for real: the claim runs in its own transaction and
 * holds its row lock, the removal is proven blocked BY that transaction's pid
 * before the claim commits, and the assertions read committed rows. The last
 * three cases race nothing. They are controls: a held claim on a slot the
 * removal did not choose, and the uncontended paired and legacy removals. The claim is the real
 * `claimSlotCore`, or its conditional UPDATE followed by the real attendance and
 * audit helpers while the removal is already parked, which is the ordering that
 * would deadlock if the removal locked the meeting any stronger than it does.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetingAttendancePlan,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	type TestTx,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
const {
	applyRemoveSpeakerSlot,
	claimSlotCore,
	evaluatorClaimedMessage,
	markComingOnSelfClaim,
	SPEAKER_CLAIMED_MESSAGE,
} = await import("./slots-logic");
const { applyAssignGuestToSlot } = await import("./guests-logic");
const { logActivity } = await import("./activity");

describe.skipIf(!hasTestDb)(
	"speaker-pair removal vs a concurrent claim",
	() => {
		let club: SeededClub;
		beforeEach(async () => {
			club = await seedClub();
		});
		afterEach(async () => {
			if (club)
				await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		const pairedSlots = async (roleIds: string[]) =>
			(
				await testDb
					.select()
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, club.meetingId))
			)
				.filter((s) => roleIds.includes(s.roleDefinitionId))
				.sort((a, b) => a.id.localeCompare(b.id));
		const logs = async () =>
			(
				await testDb
					.select()
					.from(activityLog)
					.where(eq(activityLog.clubId, club.clubId))
			).map((row) => ({
				action: row.action,
				change: (row.detail as { change?: string } | null)?.change,
			}));
		const plans = () =>
			testDb
				.select()
				.from(meetingAttendancePlan)
				.where(eq(meetingAttendancePlan.meetingId, club.meetingId));

		/**
		 * Speaker 1 already claimed by the admin, Speaker 2 open; both evaluators
		 * open. So the removal's ONLY candidate is Speaker 2 and its evaluator, and a
		 * claim of either leaves nothing it may remove.
		 */
		async function lineup(opts: { paired: boolean }) {
			const [speaker, evaluator] = await testDb
				.insert(roleDefinitions)
				.values([
					{
						clubId: club.clubId,
						key: "speaker",
						name: "Speaker",
						category: "speaker",
						isSpeakerRole: true,
						sortOrder: 10,
					},
					{
						clubId: club.clubId,
						key: "evaluator",
						name: "Evaluator",
						category: "evaluator",
						sortOrder: 11,
					},
				])
				.returning();
			const speakers = await testDb
				.insert(roleSlots)
				.values([
					{
						meetingId: club.meetingId,
						roleDefinitionId: speaker.id,
						slotIndex: 0,
						assignedMemberId: club.adminMemberId,
						status: "claimed" as const,
					},
					{
						meetingId: club.meetingId,
						roleDefinitionId: speaker.id,
						slotIndex: 1,
					},
				])
				.returning();
			const evaluators = await testDb
				.insert(roleSlots)
				.values(
					speakers.map((s, slotIndex) => ({
						meetingId: club.meetingId,
						roleDefinitionId: evaluator.id,
						slotIndex,
						evaluatesSlotId: opts.paired ? s.id : null,
					})),
				)
				.returning();
			return { roleIds: [speaker.id, evaluator.id], speakers, evaluators };
		}

		const remove = () =>
			applyRemoveSpeakerSlot({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			}).then(
				() => null,
				(e: unknown) => (e as Error).message,
			);

		/** Holds `claim` open, proves the removal is parked on ITS row lock, then
		 *  lets `whileParked` run inside the claim before it commits. */
		async function race(
			claim: (tx: TestTx) => Promise<void>,
			whileParked: (tx: TestTx) => Promise<void> = async () => {},
		) {
			let claimTx!: TestTx;
			const blocker = await openBlockingTx(async (tx) => {
				claimTx = tx;
				await claim(tx);
			});
			const removal = remove();
			let claimError: unknown = null;
			try {
				await waitForLockWait('"role_slots"', blocker.pid);
				await whileParked(claimTx);
			} catch (e) {
				claimError = e;
			} finally {
				await blocker.commit();
			}
			expect(claimError).toBeNull();
			return removal;
		}

		const fullClaim = (slotId: string) => async (tx: TestTx) => {
			await claimSlotCore(tx, {
				slotId,
				memberId: club.memberId,
				actorMemberId: club.memberId,
			});
		};

		// claimSlotCore's conditional write, paused before its attendance helper so
		// that helper's FK insert happens while the removal already holds the meeting.
		const claimUpdate = (slotId: string) => async (tx: TestTx) => {
			const updated = await tx
				.update(roleSlots)
				.set({
					assignedMemberId: club.memberId,
					assignedGuestId: null,
					status: "claimed",
					claimedAt: new Date(),
				})
				.where(and(eq(roleSlots.id, slotId), eq(roleSlots.status, "open")))
				.returning({ id: roleSlots.id });
			expect(updated).toEqual([{ id: slotId }]);
		};
		const claimTail = (slotId: string) => async (tx: TestTx) => {
			await markComingOnSelfClaim(tx, {
				memberId: club.memberId,
				actorMemberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
			});
			await logActivity(tx, {
				clubId: club.clubId,
				actorMemberId: club.memberId,
				action: "claim",
				targetType: "slot",
				targetId: slotId,
				detail: { memberId: club.memberId },
			});
		};

		const SPEAKER_REFUSAL = SPEAKER_CLAIMED_MESSAGE;
		// Speaker 2, i.e. slotIndex 1: the removal's only candidate below.
		const EVALUATOR_REFUSAL = evaluatorClaimedMessage(1);

		for (const shape of [
			"whole claimSlotCore",
			"claim, then attendance while parked",
		] as const) {
			it.each([
				["speaker", SPEAKER_REFUSAL],
				["evaluator", EVALUATOR_REFUSAL],
			] as const)(`${shape}: a claim of the chosen %s survives and nothing is removed`, async (which, message) => {
				const { roleIds, speakers, evaluators } = await lineup({
					paired: true,
				});
				const target = which === "speaker" ? speakers[1] : evaluators[1];
				const before = await pairedSlots(roleIds);

				const error =
					shape === "whole claimSlotCore"
						? await race(fullClaim(target.id))
						: await race(claimUpdate(target.id), claimTail(target.id));

				expect(error).toBe(message);
				// Every slot still there, same numbering and links; only the claim changed.
				const after = await pairedSlots(roleIds);
				expect(
					after.map(({ id, slotIndex, evaluatesSlotId }) => ({
						id,
						slotIndex,
						evaluatesSlotId,
					})),
				).toEqual(
					before.map(({ id, slotIndex, evaluatesSlotId }) => ({
						id,
						slotIndex,
						evaluatesSlotId,
					})),
				);
				expect(after.find((s) => s.id === target.id)).toMatchObject({
					assignedMemberId: club.memberId,
					status: "claimed",
				});
				expect(await plans()).toMatchObject([
					{ memberId: club.memberId, status: "coming" },
				]);
				const changes = await logs();
				expect(changes.some((l) => l.change === "speaker_removed")).toBe(false);
				expect(changes.filter((l) => l.action === "claim")).toHaveLength(1);
			});
		}

		it.each([
			["speaker", SPEAKER_REFUSAL],
			["evaluator", EVALUATOR_REFUSAL],
		] as const)("a concurrent GUEST assignment of the chosen %s survives", async (which, message) => {
			const { roleIds, speakers, evaluators } = await lineup({ paired: true });
			const target = which === "speaker" ? speakers[1] : evaluators[1];
			const before = await pairedSlots(roleIds);
			// The real guest seam, on the blocker's transaction: it sets
			// assigned_guest_id with assigned_member_id NULL, which the re-check has
			// to count as claimed on its own.
			const error = await race(async (tx) => {
				await applyAssignGuestToSlot(
					{
						slotId: target.id,
						newGuest: { name: "Visiting Guest" },
						actorMemberId: club.adminMemberId,
					},
					tx,
				);
			});
			expect(error).toBe(message);
			const after = await pairedSlots(roleIds);
			expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
			const held = after.find((s) => s.id === target.id);
			expect(held?.assignedGuestId).toBeTruthy();
			expect(held).toMatchObject({ assignedMemberId: null, status: "claimed" });
			expect((await logs()).some((l) => l.change === "speaker_removed")).toBe(
				false,
			);
		});

		it("legacy unpaired fallback: a claim of the chosen evaluator survives", async () => {
			const { roleIds, evaluators } = await lineup({ paired: false });
			const before = await pairedSlots(roleIds);
			// The fallback takes the TOP open evaluator, i.e. Evaluator 2.
			const error = await race(fullClaim(evaluators[1].id));
			expect(error).toBe(
				"That evaluator slot was just claimed. Try removing the speaker again.",
			);
			expect((await pairedSlots(roleIds)).map((s) => s.id)).toEqual(
				before.map((s) => s.id),
			);
			expect((await logs()).some((l) => l.change === "speaker_removed")).toBe(
				false,
			);
		});

		it("a held claim on a slot it did NOT choose does not block the removal", async () => {
			const { roleIds, speakers, evaluators } = await lineup({ paired: true });
			// Evaluator 1 is being claimed and held open; the removal wants Sp2 + Ev2.
			const blocker = await openBlockingTx(fullClaim(evaluators[0].id));
			try {
				// Completes while the claim is still uncommitted: only the pair is
				// locked. Bounded, so a regression that locks the whole lineup fails
				// here by name instead of parking until the claim commits, which would
				// never happen, and wedging afterEach behind it.
				const BLOCKED = Symbol("blocked");
				let timer: ReturnType<typeof setTimeout> | undefined;
				const outcome = await Promise.race([
					remove(),
					new Promise<typeof BLOCKED>((r) => {
						timer = setTimeout(() => r(BLOCKED), 3000);
					}),
				]);
				clearTimeout(timer);
				expect(
					outcome,
					"removal blocked on a claim of a slot it did not choose",
				).not.toBe(BLOCKED);
				expect(outcome).toBeNull();
			} finally {
				await blocker.commit();
			}
			const after = await pairedSlots(roleIds);
			expect(after.map((s) => s.id).sort()).toEqual(
				[speakers[0].id, evaluators[0].id].sort(),
			);
			expect(after.find((s) => s.id === evaluators[0].id)).toMatchObject({
				slotIndex: 0,
				evaluatesSlotId: speakers[0].id,
				assignedMemberId: club.memberId,
			});
			expect((await logs()).some((l) => l.change === "speaker_removed")).toBe(
				true,
			);
		});

		it.each([
			true,
			false,
		])("uncontended removal still removes the pair (paired links: %s)", async (paired) => {
			const { roleIds, speakers, evaluators } = await lineup({ paired });
			expect(await remove()).toBeNull();
			const after = await pairedSlots(roleIds);
			expect(after.map((s) => s.id).sort()).toEqual(
				[speakers[0].id, evaluators[0].id].sort(),
			);
			// Realign re-points the survivor positionally in both cases.
			expect(after.find((s) => s.id === evaluators[0].id)).toMatchObject({
				slotIndex: 0,
				evaluatesSlotId: speakers[0].id,
			});
			expect(await logs()).toEqual([
				{ action: "meeting_edit", change: "speaker_removed" },
			]);
		});
	},
);

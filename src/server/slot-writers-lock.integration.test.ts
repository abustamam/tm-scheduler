/** #835: real lock waits, followed by assertions on committed slots and audit rows. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetings,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
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
	applyAddSpeakerSlot,
	applyRemoveSpeakerSlot,
	applyMoveSpeakerSlot,
	applyMoveEvaluatorSlot,
	applyRemoveRoleSlot,
	applyTemplateSyncToUpcomingMeetings,
	syncSlotsForRoleEnabledChange,
} = await import("./slots-logic");
const { applyTemplateConversion } = await import("./meeting-templates-logic");
const { applyRoleDefinitionSetEnabled } = await import(
	"./role-definitions-logic"
);
const { resolveMeetingAgendaAuthz } = await import("./meeting-authz-logic");

// Match either the early meeting lock or the old implementation's later write.
// The blocker PID scopes the wait to this fixture even with parallel suites.
async function race(
	change: (tx: TestTx) => Promise<void>,
	subject: () => Promise<unknown>,
) {
	const blocker = await openBlockingTx(change);
	const outcome = subject().then(
		(value) => ({ value, error: null }),
		(e: unknown) => ({ value: null, error: (e as Error).message }),
	);
	try {
		await waitForLockWait("", blocker.pid);
	} finally {
		await blocker.commit();
		await outcome;
	}
	return outcome;
}

async function lock(tx: TestTx, meetingId: string) {
	await tx
		.select({ id: meetings.id })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.for("update");
}

describe.skipIf(!hasTestDb)(
	"remaining slot writers serialize meeting decisions",
	() => {
		let club: SeededClub;
		beforeEach(async () => {
			club = await seedClub();
		});
		afterEach(async () => {
			if (club)
				await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		const slots = () =>
			testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, club.meetingId))
				.orderBy(roleSlots.id);
		const logs = () =>
			testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.clubId, club.clubId))
				.orderBy(activityLog.id);
		const sync = () =>
			applyTemplateSyncToUpcomingMeetings({
				clubId: club.clubId,
				actorMemberId: club.adminMemberId,
			});
		const enable = () =>
			syncSlotsForRoleEnabledChange({
				clubId: club.clubId,
				roleDefinitionId: club.roleDefinitionId,
				roleName: "Timer",
				defaultCount: 1,
				standing: true,
				enabled: true,
				actorMemberId: club.adminMemberId,
			});
		const convert = () =>
			applyTemplateConversion({
				meetingId: club.meetingId,
				clubId: club.clubId,
				templateId: null,
				actorMemberId: club.adminMemberId,
			});

		async function template(
			roles: {
				key: string;
				name: string;
				category: typeof roleDefinitions.$inferInsert.category;
				isSpeakerRole: boolean;
			}[],
		) {
			const [row] = await testDb
				.insert(meetingTemplates)
				.values({
					clubId: club.clubId,
					key: `race-${randomUUID()}`,
					name: "Race shape",
				})
				.returning();
			await testDb.insert(meetingTemplateRoles).values(
				roles.map((role, i) => ({
					...role,
					templateId: row.id,
					sortOrder: i,
					defaultCount: 1,
				})),
			);
			return row.id;
		}

		async function lineup() {
			const [speaker, evaluator, tmod] = await testDb
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
					{
						clubId: club.clubId,
						key: "toastmaster_of_the_day",
						name: "Toastmaster of the Day",
						category: "functionary",
						sortOrder: 1,
					},
				])
				.returning();
			const speakers = await testDb
				.insert(roleSlots)
				.values(
					[0, 1].map((slotIndex) => ({
						meetingId: club.meetingId,
						roleDefinitionId: speaker.id,
						slotIndex,
					})),
				)
				.returning();
			const evaluators = await testDb
				.insert(roleSlots)
				.values(
					speakers.map((s, slotIndex) => ({
						meetingId: club.meetingId,
						roleDefinitionId: evaluator.id,
						slotIndex,
						evaluatesSlotId: s.id,
					})),
				)
				.returning();
			await testDb.insert(roleSlots).values({
				meetingId: club.meetingId,
				roleDefinitionId: tmod.id,
				assignedMemberId: club.memberId,
				status: "confirmed",
			});
			return { speaker, evaluator, speakers, evaluators };
		}

		it.each([
			"sync",
			"enable",
			"conversion",
		] as const)("%s sees a concurrent add before deciding a role is missing", async (kind) => {
			await testDb.delete(roleSlots).where(eq(roleSlots.id, club.slotId));
			const result = await race(
				async (tx) => {
					await lock(tx, club.meetingId);
					await tx.insert(roleSlots).values({
						meetingId: club.meetingId,
						roleDefinitionId: club.roleDefinitionId,
						slotIndex: 0,
					});
				},
				kind === "sync" ? sync : kind === "enable" ? enable : convert,
			);
			expect(result.error).toBeNull();
			expect((await slots()).map((s) => s.slotIndex)).toEqual([0]);
			if (kind !== "conversion") {
				expect(result.value).toMatchObject({
					meetingsChanged: 0,
					rolesAdded: [],
				});
				expect(await logs()).toEqual([]);
			}
		});

		it("conversion removes a concurrently added role absent from the target shape", async () => {
			const [extra] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					name: "Extra",
					category: "functionary",
					standing: false,
				})
				.returning();
			const result = await race(async (tx) => {
				await lock(tx, club.meetingId);
				await tx
					.insert(roleSlots)
					.values({ meetingId: club.meetingId, roleDefinitionId: extra.id });
			}, convert);
			expect(result.error).toBeNull();
			expect((await slots()).map((s) => s.roleDefinitionId)).toEqual([
				club.roleDefinitionId,
			]);
		});

		it.each([
			"sync",
			"enable",
		] as const)("%s rechecks the standard shape after waiting", async (kind) => {
			await testDb.delete(roleSlots).where(eq(roleSlots.id, club.slotId));
			const templateId = await template([
				{
					key: "contestant",
					name: "Contestant",
					category: "speaker",
					isSpeakerRole: true,
				},
			]);
			const result = await race(
				async (tx) => {
					await lock(tx, club.meetingId);
					await tx
						.update(meetings)
						.set({ templateId })
						.where(eq(meetings.id, club.meetingId));
				},
				kind === "sync" ? sync : enable,
			);
			expect(result).toMatchObject({
				error: null,
				value: { meetingsChanged: 0, rolesAdded: [] },
			});
			expect(await slots()).toEqual([]);
			expect(await logs()).toEqual([]);
		});

		it.each([
			"sync",
			"enable",
		] as const)("%s rechecks the future date after waiting", async (kind) => {
			await testDb.delete(roleSlots).where(eq(roleSlots.id, club.slotId));
			const result = await race(
				async (tx) => {
					await lock(tx, club.meetingId);
					await tx
						.update(meetings)
						.set({ scheduledAt: new Date(0) })
						.where(eq(meetings.id, club.meetingId));
				},
				kind === "sync" ? sync : enable,
			);
			expect(result).toMatchObject({
				error: null,
				value: { meetingsChanged: 0 },
			});
			expect(await slots()).toEqual([]);
			expect(await logs()).toEqual([]);
		});

		it.each([
			"sync",
			"enable",
		] as const)("%s preserves its cancellation policy under a race", async (kind) => {
			await testDb.delete(roleSlots).where(eq(roleSlots.id, club.slotId));
			const result = await race(
				async (tx) => {
					await lock(tx, club.meetingId);
					await tx
						.update(meetings)
						.set({ status: "cancelled" })
						.where(eq(meetings.id, club.meetingId));
				},
				kind === "sync" ? sync : enable,
			);
			expect(result).toMatchObject({
				error: null,
				value: { meetingsChanged: kind === "sync" ? 1 : 0 },
			});
			expect((await slots()).length).toBe(kind === "sync" ? 1 : 0);
		});

		it.each([
			"sync",
			"enable",
			"conversion",
			"remove role",
		] as const)("%s refuses completion committed while waiting without writing", async (kind) => {
			if (kind !== "remove role")
				await testDb.delete(roleSlots).where(eq(roleSlots.id, club.slotId));
			const before = await slots();
			const result = await race(
				async (tx) => {
					await lock(tx, club.meetingId);
					await tx
						.update(meetings)
						.set({ status: "completed" })
						.where(eq(meetings.id, club.meetingId));
					// Old remove-role code reaches DELETE without ever locking meetings.
					await tx
						.update(roleSlots)
						.set({ status: "open" })
						.where(eq(roleSlots.id, club.slotId));
				},
				kind === "sync"
					? sync
					: kind === "enable"
						? enable
						: kind === "conversion"
							? convert
							: () =>
									applyRemoveRoleSlot({
										slotId: club.slotId,
										actorMemberId: club.adminMemberId,
									}),
			);
			expect(result.error).toBe(MEETING_LOCKED_MESSAGE);
			expect(await slots()).toEqual(before);
			expect(await logs()).toEqual([]);
		});

		it("remove role rechecks the paired-role gate after conversion", async () => {
			await testDb
				.update(roleDefinitions)
				.set({ key: "timer" })
				.where(eq(roleDefinitions.id, club.roleDefinitionId));
			const templateId = await template([
				{
					key: "timer",
					name: "Timer",
					category: "speaker",
					isSpeakerRole: true,
				},
			]);
			const before = await slots();
			const result = await race(
				async (tx) => {
					await lock(tx, club.meetingId);
					await tx
						.update(meetings)
						.set({ templateId })
						.where(eq(meetings.id, club.meetingId));
					await tx
						.update(roleSlots)
						.set({ status: "open" })
						.where(eq(roleSlots.id, club.slotId));
				},
				() =>
					applyRemoveRoleSlot({
						slotId: club.slotId,
						actorMemberId: club.adminMemberId,
					}),
			);
			expect(result.error).toBe("Remove speakers with the speaker controls.");
			expect(await slots()).toEqual(before);
			expect(await logs()).toEqual([]);
		});

		it("remove role preserves a claim committed while it waits for the slot", async () => {
			const result = await race(
				async (tx) => {
					await tx
						.update(roleSlots)
						.set({ assignedMemberId: club.memberId, status: "confirmed" })
						.where(eq(roleSlots.id, club.slotId));
				},
				() =>
					applyRemoveRoleSlot({
						slotId: club.slotId,
						actorMemberId: club.adminMemberId,
					}),
			);
			expect(result.error).toBe("Release the role before removing it.");
			expect(await slots()).toMatchObject([
				{
					id: club.slotId,
					assignedMemberId: club.memberId,
					status: "confirmed",
				},
			]);
			expect(await logs()).toEqual([]);
		});

		for (const actor of ["admin", "tmod"] as const) {
			it.each([
				"add",
				"remove",
				"move speaker",
				"move evaluator",
			] as const)(`${actor}: %s rechecks completion after agenda authorization`, async (kind) => {
				const { speakers, evaluators } = await lineup();
				const authz = await resolveMeetingAgendaAuthz({
					meetingId: club.meetingId,
					sessionUserId: actor === "admin" ? club.adminUserId : null,
					selfMemberId: actor === "tmod" ? club.memberId : null,
				});
				expect(authz.allowed).toBe(true);
				expect(authz.via).toBe(
					actor === "admin" ? "admin" : "tmod-self-assert",
				);
				const before = await slots();
				const input = {
					meetingId: club.meetingId,
					actorMemberId: authz.actorMemberId,
				};
				const result = await race(
					async (tx) => {
						await tx
							.update(meetings)
							.set({ status: "completed" })
							.where(eq(meetings.id, club.meetingId));
					},
					() =>
						kind === "add"
							? applyAddSpeakerSlot(input)
							: kind === "remove"
								? applyRemoveSpeakerSlot(input)
								: kind === "move speaker"
									? applyMoveSpeakerSlot({
											...input,
											slotId: speakers[0].id,
											direction: "down",
										})
									: applyMoveEvaluatorSlot({
											...input,
											slotId: evaluators[0].id,
											direction: "down",
										}),
				);
				expect(result.error).toBe(MEETING_LOCKED_MESSAGE);
				expect(await slots()).toEqual(before);
				expect(await logs()).toEqual([]);
			});
		}

		it.each([
			"sync",
			"enable",
		] as const)("%s locks meetings by id, not candidate query order", async (kind) => {
			const firstId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
			await testDb.insert(meetings).values({
				id: firstId,
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 8 * 86400000),
			});
			const blocker = await openBlockingTx((tx) => lock(tx, firstId));
			const pending = (kind === "sync" ? sync() : enable()).then(
				(value) => ({ value, error: null }),
				(error: unknown) => ({ value: null, error }),
			);
			try {
				await waitForLockWait('from "meetings"', blocker.pid);
				// The higher id must still be unlocked while the backfill waits on
				// the lower one, even though it was inserted/scheduled first.
				await testDb.transaction(async (tx) => {
					await tx
						.select({ id: meetings.id })
						.from(meetings)
						.where(eq(meetings.id, club.meetingId))
						.for("update", { noWait: true });
				});
			} finally {
				await blocker.commit();
				await pending;
			}
			expect((await pending).error).toBeNull();
		});

		it("a completed meeting rolls back earlier backfill inserts and audit rows", async () => {
			await testDb.delete(roleSlots).where(eq(roleSlots.id, club.slotId));
			await testDb.insert(meetings).values({
				id: `ffffffff-ffff-4fff-8fff-${randomUUID().slice(-12)}`,
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 8 * 86400000),
				status: "completed",
			});
			await expect(sync()).rejects.toThrow(MEETING_LOCKED_MESSAGE);
			expect(await slots()).toEqual([]);
			expect(await logs()).toEqual([]);
		});

		it("a refused enable backfill leaves the role flag unchanged", async () => {
			await testDb
				.update(roleDefinitions)
				.set({ enabled: false })
				.where(eq(roleDefinitions.id, club.roleDefinitionId));
			await testDb.delete(roleSlots).where(eq(roleSlots.id, club.slotId));
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, club.meetingId));
			await expect(
				applyRoleDefinitionSetEnabled({
					clubId: club.clubId,
					roleId: club.roleDefinitionId,
					enabled: true,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_LOCKED_MESSAGE);
			const [role] = await testDb
				.select()
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, club.roleDefinitionId));
			expect(role.enabled).toBe(false);
			expect(await slots()).toEqual([]);
			expect(await logs()).toEqual([]);
		});

		it("move evaluator follows a slot repointed by conversion while waiting", async () => {
			const { evaluators } = await lineup();
			const [newEvaluator] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					key: "judge",
					name: "Judge",
					category: "evaluator",
					standing: false,
				})
				.returning();
			const templateId = await template([
				{
					key: "speaker",
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				},
				{
					key: "judge",
					name: "Judge",
					category: "evaluator",
					isSpeakerRole: false,
				},
			]);
			const result = await race(
				async (tx) => {
					await lock(tx, club.meetingId);
					await tx
						.update(meetings)
						.set({ templateId })
						.where(eq(meetings.id, club.meetingId));
					for (const slot of evaluators)
						await tx
							.update(roleSlots)
							.set({ roleDefinitionId: newEvaluator.id })
							.where(eq(roleSlots.id, slot.id));
				},
				() =>
					applyMoveEvaluatorSlot({
						slotId: evaluators[0].id,
						direction: "down",
						actorMemberId: club.adminMemberId,
					}),
			);
			expect(result.error).toBeNull();
			const after = await slots();
			expect(after.find((s) => s.id === evaluators[0].id)?.slotIndex).toBe(1);
			expect(after.find((s) => s.id === evaluators[1].id)?.slotIndex).toBe(0);
		});

		it("remove speaker resolves the new shape after waiting", async () => {
			const { speakers, evaluators } = await lineup();
			const [contestant] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					key: "contestant",
					name: "Contestant",
					category: "speaker",
					isSpeakerRole: true,
					standing: false,
				})
				.returning();
			const [slot] = await testDb
				.insert(roleSlots)
				.values({ meetingId: club.meetingId, roleDefinitionId: contestant.id })
				.returning();
			const templateId = await template([
				{
					key: "contestant",
					name: "Contestant",
					category: "speaker",
					isSpeakerRole: true,
				},
			]);
			const result = await race(
				async (tx) => {
					await tx
						.update(meetings)
						.set({ templateId })
						.where(eq(meetings.id, club.meetingId));
				},
				() =>
					applyRemoveSpeakerSlot({
						meetingId: club.meetingId,
						actorMemberId: club.adminMemberId,
					}),
			);
			expect(result.error).toBeNull();
			const ids = (await slots()).map((s) => s.id);
			expect(ids).not.toContain(slot.id);
			for (const s of [...speakers, ...evaluators]) expect(ids).toContain(s.id);
		});

		it("move evaluator refuses the old pair after conversion", async () => {
			const { evaluators } = await lineup();
			await testDb.insert(roleDefinitions).values({
				clubId: club.clubId,
				key: "contestant",
				name: "Contestant",
				category: "speaker",
				isSpeakerRole: true,
				standing: false,
			});
			const templateId = await template([
				{
					key: "contestant",
					name: "Contestant",
					category: "speaker",
					isSpeakerRole: true,
				},
			]);
			const before = await slots();
			const result = await race(
				async (tx) => {
					await tx
						.update(meetings)
						.set({ templateId })
						.where(eq(meetings.id, club.meetingId));
				},
				() =>
					applyMoveEvaluatorSlot({
						slotId: evaluators[0].id,
						direction: "down",
						actorMemberId: club.adminMemberId,
					}),
			);
			expect(result.error).toBe("That slot is not an evaluator slot.");
			expect(await slots()).toEqual(before);
			expect(await logs()).toEqual([]);
		});
	},
);

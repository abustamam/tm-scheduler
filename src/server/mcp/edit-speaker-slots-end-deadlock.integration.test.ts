/**
 * A batched `edit_speaker_slots` racing a member's End (#1641).
 *
 * Card: protects=a batch that moves a higher-id slot pair before a lower-id one
 * and a member's End (which releases their slots in id order, taking no
 * meeting lock) both complete, one after the other; fails_when=the tool's
 * row locks pile up in request order again (Postgres aborts one side with
 * 40P01, a REJECTED promise here, not a hang); no_claim=the plan, hash and
 * refusals of the tool (`edit-speaker-slots.integration.test.ts`).
 *
 * Five speakers i0..i4 (ascending id, laid out at positions 0..4), each paired
 * with an evaluator. A member holds i1 (low) and i3 (high). The batch is
 * [move i3 down, move i1 up]: i3's pair is written first, i1's second, so
 * without the up-front lock the tool holds the high slot and then waits on the
 * low one, while the End holds the low one and waits on the high one.
 *
 * Case 1, the End gets in first. Two blockers hold i0 and i2 (i2 sits between
 * the member's slots, so a tool locking in DESCENDING id parks on it holding
 * i3):
 *   1. the tool applies and parks on a blocker; with the fix it holds nothing
 *      yet (i0 is the lowest lineup id of the three);
 *   2. the End starts. Without the fix it takes i1 and parks on i2/i3 behind
 *      the tool; with it nothing the tool holds is in its way and it commits;
 *   3. the blockers commit. The End changed who holds the slots, so the tool
 *      answers PLAN_STALE and writes nothing.
 * Case 2, the tool gets in first. One blocker holds i4 (the highest of the
 * five, above both of the member's slots), so the tool locks every lower lineup
 * slot, i1 and i3 among them, and parks on i4. The End starts and parks behind
 * the tool; the blocker commits; the batch applies, then the End succeeds.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	members,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { editSpeakerSlotsTool } = await import(
	"#/server/mcp/tools/edit-speaker-slots"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { applyAddSpeakerSlot, realignEvaluatorPairs } = await import(
	"#/server/slots-logic"
);
const { applySetMemberStatus } = await import("#/server/members-logic");

describe.skipIf(!hasTestDb)(
	"edit_speaker_slots batch vs a member's End (#1641)",
	() => {
		let seed: SeededClub;
		let token: string;
		let speakerRoleId: string;
		let evaluatorRoleId: string;
		const extraUsers: string[] = [];

		beforeEach(async () => {
			seed = await seedClub();
			const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
			await testDb
				.insert(apiTokens)
				.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
			token = raw;
			const [sp] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
					defaultCount: 5,
					sortOrder: 1,
				})
				.returning({ id: roleDefinitions.id });
			const [ev] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Evaluator",
					category: "evaluator",
					isSpeakerRole: false,
					defaultCount: 5,
					sortOrder: 2,
				})
				.returning({ id: roleDefinitions.id });
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			speakerRoleId = sp!.id;
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			evaluatorRoleId = ev!.id;
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			for (const id of extraUsers.splice(0)) {
				await testDb.delete(user).where(eq(user.id, id));
			}
		});

		async function addMember(name: string): Promise<string> {
			const userId = randomUUID();
			extraUsers.push(userId);
			await testDb.insert(user).values({
				id: userId,
				name,
				email: `${userId}@test.example`,
				emailVerified: true,
			});
			const [person] = await testDb
				.insert(people)
				.values({ name, email: `${userId}@test.example`, userId })
				.returning({ id: people.id });
			const [member] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					// biome-ignore lint/style/noNonNullAssertion: insert returns a row
					personId: person!.id,
					name,
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			return member!.id;
		}

		/** The pid of a backend running a role_slots statement behind `pid`'s locks. */
		const parkedBehind = (pid: number | number[]) =>
			waitForLockWait("role_slots", pid);

		/** True once the End has finished or is waiting on `pid`'s locks. */
		async function endSettledOrParked(
			ended: Promise<unknown>,
			pid: number,
		): Promise<void> {
			let settled = false;
			ended.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (settled) return;
				try {
					await waitForLockWait("role_slots", pid, 100);
					return;
				} catch {
					// not parked yet; the loop re-checks `settled`
				}
			}
			throw new Error("the End neither finished nor parked on the tool");
		}

		/** Five speakers in ascending id order, positions 0..4, a member on i1 and i3. */
		async function seedLineup() {
			for (let i = 0; i < 5; i++) {
				await applyAddSpeakerSlot({
					meetingId: seed.meetingId,
					actorMemberId: null,
				});
			}
			const speakers = (
				await testDb
					.select({ id: roleSlots.id })
					.from(roleSlots)
					.where(eq(roleSlots.roleDefinitionId, speakerRoleId))
					.orderBy(asc(roleSlots.id))
			).map((r) => r.id);
			expect(speakers).toHaveLength(5);
			// Position follows creation order, not id order. Re-number in two
			// passes (10+k, then k): the first clears the unique (meeting, role,
			// slotIndex) positions so the second cannot collide mid-way.
			for (const [k, id] of speakers.entries()) {
				await testDb
					.update(roleSlots)
					.set({ slotIndex: 10 + k })
					.where(eq(roleSlots.id, id));
			}
			for (const [k, id] of speakers.entries()) {
				await testDb
					.update(roleSlots)
					.set({ slotIndex: k })
					.where(eq(roleSlots.id, id));
			}
			await realignEvaluatorPairs(
				testDb,
				seed.meetingId,
				speakerRoleId,
				evaluatorRoleId,
			);
			const [i0, i1, i2, i3, i4] = speakers as [
				string,
				string,
				string,
				string,
				string,
			];
			const holder = await addMember("Held Both");
			for (const id of [i1, i3]) {
				await testDb
					.update(roleSlots)
					.set({ assignedMemberId: holder, status: "confirmed" })
					.where(eq(roleSlots.id, id));
			}
			const batch = {
				meetingId: seed.meetingId,
				moveSpeakers: [
					{ slotId: i3, direction: "down" },
					{ slotId: i1, direction: "up" },
				],
			};
			const preview = (await editSpeakerSlotsTool.handler(batch, {
				rawToken: token,
			})) as unknown as { planHash: string; blocking: unknown[] };
			expect(preview.blocking).toEqual([]);
			return {
				ids: [i0, i1, i2, i3, i4],
				holder,
				batch,
				hash: preview.planHash,
			};
		}

		const hold = (id: string) =>
			openBlockingTx(async (tx) => {
				await tx
					.select({ id: roleSlots.id })
					.from(roleSlots)
					.where(eq(roleSlots.id, id))
					.for("update");
			});

		async function speakerOrder(): Promise<string[]> {
			return (
				await testDb
					.select({ id: roleSlots.id })
					.from(roleSlots)
					.where(eq(roleSlots.roleDefinitionId, speakerRoleId))
					.orderBy(asc(roleSlots.slotIndex))
			).map((r) => r.id);
		}

		it("the End gets in first: both settle, the batch is PLAN_STALE and writes nothing", async () => {
			const { ids, holder, batch, hash } = await seedLineup();
			const [i0, , i2] = ids as [string, string, string];
			const blockers: { commit: () => Promise<void> }[] = [];
			let applying: Promise<unknown> | undefined;
			let ending: Promise<unknown> | undefined;
			try {
				const b0 = await hold(i0);
				blockers.push(b0);
				const b2 = await hold(i2);
				blockers.push(b2);
				applying = editSpeakerSlotsTool.handler(
					{ ...batch, planHash: hash },
					{ rawToken: token },
				);
				applying.catch(() => {});
				const toolPid = await parkedBehind([b0.pid, b2.pid]);
				ending = applySetMemberStatus({
					clubId: seed.clubId,
					memberId: holder,
					status: "inactive",
					actorMemberId: seed.adminMemberId,
				});
				ending.catch(() => {});
				await endSettledOrParked(ending, toolPid);
			} finally {
				for (const b of blockers) await b.commit().catch(() => {});
				await Promise.allSettled([applying, ending]);
			}
			const [applied, ended] = await Promise.allSettled([
				applying as Promise<unknown>,
				ending as Promise<unknown>,
			]);
			// A 40P01 would surface as INTERNAL from the tool or fail the End.
			expect(applied.status).toBe("rejected");
			expect((applied as PromiseRejectedResult).reason).toMatchObject({
				code: "PLAN_STALE",
			});
			expect(
				ended.status,
				String((ended as PromiseRejectedResult).reason),
			).toBe("fulfilled");
			// PLAN_STALE rolled the whole batch back: positions are untouched.
			expect(await speakerOrder()).toEqual(ids);
		}, 30_000);

		it("the tool gets in first: the batch applies, then the End succeeds", async () => {
			const { ids, holder, batch, hash } = await seedLineup();
			const i4 = ids[4] as string;
			const blockers: { commit: () => Promise<void> }[] = [];
			let applying: Promise<unknown> | undefined;
			let ending: Promise<unknown> | undefined;
			try {
				const b4 = await hold(i4);
				blockers.push(b4);
				applying = editSpeakerSlotsTool.handler(
					{ ...batch, planHash: hash },
					{ rawToken: token },
				);
				applying.catch(() => {});
				// Parked on i4 with every lower lineup slot (i1, i3) already held.
				const toolPid = await parkedBehind(b4.pid);
				ending = applySetMemberStatus({
					clubId: seed.clubId,
					memberId: holder,
					status: "inactive",
					actorMemberId: seed.adminMemberId,
				});
				ending.catch(() => {});
				await parkedBehind(toolPid);
			} finally {
				for (const b of blockers) await b.commit().catch(() => {});
				await Promise.allSettled([applying, ending]);
			}
			const [applied, ended] = await Promise.allSettled([
				applying as Promise<unknown>,
				ending as Promise<unknown>,
			]);
			expect(
				applied.status,
				String((applied as PromiseRejectedResult).reason),
			).toBe("fulfilled");
			expect(
				(applied as PromiseFulfilledResult<{ applied: boolean }>).value.applied,
			).toBe(true);
			expect(
				ended.status,
				String((ended as PromiseRejectedResult).reason),
			).toBe("fulfilled");
			const [i0, i1, i2, i3] = ids as [string, string, string, string];
			expect(await speakerOrder()).toEqual([i1, i0, i2, i4, i3]);
		}, 30_000);
	},
);

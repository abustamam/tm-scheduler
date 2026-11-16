/**
 * A batched `edit_speaker_slots` racing a member's End (#1641).
 *
 * Card: protects=a batch that moves a higher-id slot pair before a lower-id one
 * and a member's End (which releases their slots in id order, taking no
 * meeting lock) both complete, one after the other; fails_when=the tool's
 * row locks pile up in request order again (Postgres aborts one side with
 * 40P01, a REJECTED promise here, not a hang); no_claim=the plan, hash and refusals of the
 * tool (`edit-speaker-slots.integration.test.ts`).
 *
 * Without the up-front lock the tool holds slot i2 (step 1) and waits on i1
 * (step 2) while the End holds i1 and waits on i2. The interleave is forced:
 *   1. a blocker holds i0 FOR UPDATE;
 *   2. the tool applies [move i3 up, move i1 up]: step 1 writes i2 and i3, step
 *      2 parks on i0 behind the blocker (with the fix it parks there before
 *      writing anything, having locked every slot below i0 only);
 *   3. the End of the member holding i1 and i2 starts. Without the fix it takes
 *      i1 and parks on i2 behind the tool; with it, nothing the tool holds is
 *      in its way and it completes;
 *   4. the blocker commits.
 */
import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
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

		/** The pid of the tool's backend once it waits on a lock of `pids`. */
		async function toolParkedOn(pids: number[]): Promise<number> {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const res = await testDb.execute(sql`
					select pid from pg_stat_activity
					where datname = current_database()
					  and state = 'active' and wait_event_type = 'Lock'
					  and query ilike '%role_slots%'
					  and pg_blocking_pids(pid) && ${sql.param(pids)}::int[]
					limit 1`);
				const pid = (res.rows[0] as { pid?: number } | undefined)?.pid;
				if (pid) return pid;
				await new Promise((r) => setTimeout(r, 25));
			}
			throw new Error("the tool never parked behind a blocker");
		}

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
				const res = await testDb.execute(sql`
					select 1 from pg_stat_activity
					where datname = current_database()
					  and wait_event_type = 'Lock'
					  and ${pid} = any(pg_blocking_pids(pid))
					limit 1`);
				if (res.rows.length > 0) return;
				await new Promise((r) => setTimeout(r, 25));
			}
			throw new Error("the End neither finished nor parked on the tool");
		}

		it("completes both with no deadlock", async () => {
			for (let i = 0; i < 5; i++) {
				await applyAddSpeakerSlot({
					meetingId: seed.meetingId,
					actorMemberId: null,
				});
			}
			// Speakers laid out in id order: i0..i4 at positions 0..4.
			const speakers = (
				await testDb
					.select({ id: roleSlots.id })
					.from(roleSlots)
					.where(eq(roleSlots.roleDefinitionId, speakerRoleId))
					.orderBy(asc(roleSlots.id))
			).map((r) => r.id);
			expect(speakers).toHaveLength(5);
			const [i0, i1, i2, i3, i4] = speakers as [
				string,
				string,
				string,
				string,
				string,
			];
			expect(i4).toBeTruthy();
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

			// One member holds a slot in each of the two pairs: i1 (low) and i3 (high).
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

			// 1. Two blockers: b0 holds i0, b2 holds i2 (between the member's two
			//    slots, so a tool locking in DESCENDING id parks there, holding i3).
			const hold = (id: string) =>
				openBlockingTx(async (tx) => {
					await tx
						.select({ id: roleSlots.id })
						.from(roleSlots)
						.where(eq(roleSlots.id, id))
						.for("update");
				});
			const b0 = await hold(i0);
			const b2 = await hold(i2);
			// 2. The tool, parked behind one of them.
			const applying = editSpeakerSlotsTool.handler(
				{ ...batch, planHash: preview.planHash },
				{ rawToken: token },
			);
			applying.catch(() => {});
			const toolPid = await toolParkedOn([b0.pid, b2.pid]);
			// 3. The End of the member holding i1 and i2.
			const ending = applySetMemberStatus({
				clubId: seed.clubId,
				memberId: holder,
				status: "inactive",
				actorMemberId: seed.adminMemberId,
			});
			ending.catch(() => {});
			await endSettledOrParked(ending, toolPid);
			// 4. Release.
			await b0.commit();
			await b2.commit();

			const [applied, ended] = await Promise.allSettled([applying, ending]);
			// The End releasing the member's slots changes the holders the plan
			// was hashed over, so the tool may answer PLAN_STALE once the End has
			// committed first: a refusal, not a deadlock. A 40P01 surfaces as
			// INTERNAL (or fails the End), and fails here.
			if (applied.status === "rejected") {
				expect((applied.reason as { code?: string }).code).toBe("PLAN_STALE");
			}
			expect(
				ended.status,
				String((ended as PromiseRejectedResult).reason),
			).toBe("fulfilled");
			const rows = await testDb
				.select({ id: roleSlots.id, held: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.roleDefinitionId, speakerRoleId));
			expect(rows.filter((r) => r.held === holder)).toEqual([]);
		}, 30_000);
	},
);

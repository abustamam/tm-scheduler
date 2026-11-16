/**
 * A speech relink racing an `edit_speaker_slots` call on the same meeting
 * (#1641).
 *
 * Card: protects=`attachSpeechToOpenSlot` moving a speech from a higher-id
 * speaker slot to a lower-id one settles with a tool call that locks the
 * meeting's whole lineup in id order; fails_when=the relink writes its source
 * before taking its target again (Postgres aborts one side with 40P01, a
 * REJECTED promise here, not a hang); no_claim=the relink's checks, messages
 * and result (`speeches.integration.test.ts`).
 *
 * Speaker slots L < H (by id), the speech on H (held by its owner), L open.
 * The interleave is forced:
 *   1. a blocker holds L FOR UPDATE;
 *   2. the tool (a preview: it takes the lineup lock too) parks on L, holding
 *      every lineup slot below it;
 *   3. the relink starts. Without the ordered lock it unlinks H, takes it, and
 *      parks on L behind the blocker; with it, it parks on L holding nothing;
 *   4. the blocker commits. Without the fix the tool gets L and wants H while
 *      the relink holds H and wants L: a deadlock. With it the tool finishes
 *      first and the relink follows.
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
	speeches,
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
const { applyAddSpeakerSlot } = await import("#/server/slots-logic");
const { attachSpeechToOpenSlot } = await import("#/server/speeches-logic");

describe.skipIf(!hasTestDb)(
	"speech relink vs edit_speaker_slots lineup lock (#1641)",
	() => {
		let seed: SeededClub;
		let token: string;
		let speakerRoleId: string;
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
					defaultCount: 2,
					sortOrder: 1,
				})
				.returning({ id: roleDefinitions.id });
			await testDb.insert(roleDefinitions).values({
				clubId: seed.clubId,
				name: "Evaluator",
				category: "evaluator",
				isSpeakerRole: false,
				defaultCount: 2,
				sortOrder: 2,
			});
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			speakerRoleId = sp!.id;
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			for (const id of extraUsers.splice(0)) {
				await testDb.delete(user).where(eq(user.id, id));
			}
		});

		it("a relink from the higher-id slot to the lower-id one settles with the tool", async () => {
			for (let i = 0; i < 2; i++) {
				await applyAddSpeakerSlot({
					meetingId: seed.meetingId,
					actorMemberId: null,
				});
			}
			const [lowId, highId] = (
				await testDb
					.select({ id: roleSlots.id })
					.from(roleSlots)
					.where(eq(roleSlots.roleDefinitionId, speakerRoleId))
					.orderBy(asc(roleSlots.id))
			).map((r) => r.id) as [string, string];

			const userId = randomUUID();
			extraUsers.push(userId);
			await testDb.insert(user).values({
				id: userId,
				name: "Relinker",
				email: `${userId}@test.example`,
				emailVerified: true,
			});
			const [person] = await testDb
				.insert(people)
				.values({ name: "Relinker", email: `${userId}@test.example`, userId })
				.returning({ id: people.id });
			const [member] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					// biome-ignore lint/style/noNonNullAssertion: insert returns a row
					personId: person!.id,
					name: "Relinker",
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			const [speech] = await testDb
				.insert(speeches)
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				.values({ personId: person!.id, title: "Relink me" })
				.returning({ id: speeches.id });
			// The speech sits on the HIGHER-id slot, held by its owner.
			await testDb
				.update(roleSlots)
				.set({
					// biome-ignore lint/style/noNonNullAssertion: insert returns a row
					assignedMemberId: member!.id,
					status: "claimed",
					// biome-ignore lint/style/noNonNullAssertion: insert returns a row
					speechId: speech!.id,
				})
				.where(eq(roleSlots.id, highId));

			const blocker = await openBlockingTx(async (tx) => {
				await tx
					.select({ id: roleSlots.id })
					.from(roleSlots)
					.where(eq(roleSlots.id, lowId))
					.for("update");
			});
			let tool: Promise<unknown> | undefined;
			let relink: Promise<unknown> | undefined;
			try {
				tool = editSpeakerSlotsTool.handler(
					{ meetingId: seed.meetingId, addSpeakers: 1 },
					{ rawToken: token },
				);
				tool.catch(() => {});
				const toolPid = await waitForLockWait("role_slots", blocker.pid);
				relink = testDb.transaction((tx) =>
					attachSpeechToOpenSlot(tx, {
						// biome-ignore lint/style/noNonNullAssertion: insert returns a row
						speechId: speech!.id,
						slotId: lowId,
						actorMemberId: seed.adminMemberId,
					}),
				);
				relink.catch(() => {});
				// Both backends are now parked (the tool on the blocker, the relink
				// on the blocker or queued behind the tool), so the release is a
				// real race.
				const deadline = Date.now() + 10_000;
				for (;;) {
					const res = await testDb.execute(sql`
						select count(*)::int as n from pg_stat_activity
						where datname = current_database()
						  and state = 'active' and wait_event_type = 'Lock'
						  and query ilike '%role_slots%'
						  and pg_blocking_pids(pid) && ${sql.param([blocker.pid, toolPid])}::int[]`);
					if ((res.rows[0] as { n: number }).n >= 2) break;
					if (Date.now() > deadline) {
						throw new Error("the tool and the relink never both parked");
					}
					await new Promise((r) => setTimeout(r, 25));
				}
			} finally {
				await blocker.commit().catch(() => {});
				await Promise.allSettled([tool, relink]);
			}
			const [toolRes, relinkRes] = await Promise.allSettled([
				tool as Promise<unknown>,
				relink as Promise<unknown>,
			]);
			// A 40P01 rejects one side (INTERNAL from the tool, the pg error from
			// the relink).
			expect(
				toolRes.status,
				String((toolRes as PromiseRejectedResult).reason),
			).toBe("fulfilled");
			expect(
				relinkRes.status,
				String((relinkRes as PromiseRejectedResult).reason),
			).toBe("fulfilled");
			const rows = await testDb
				.select({ id: roleSlots.id, speechId: roleSlots.speechId })
				.from(roleSlots)
				.where(eq(roleSlots.roleDefinitionId, speakerRoleId));
			expect(rows.find((r) => r.id === lowId)?.speechId).toBe(speech?.id);
			expect(rows.find((r) => r.id === highId)?.speechId).toBeNull();
		}, 30_000);
	},
);

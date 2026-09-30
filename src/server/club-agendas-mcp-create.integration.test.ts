/**
 * The fourth creation path (#910, AC4): a meeting CREATED by an applied
 * `upsert_agendas` plan starts on a private copy of the club's default agenda,
 * like the top-up, batch and manual paths (`club-agendas.integration.test.ts`).
 *
 * Driven end to end the way production drives it — the MCP tool writes a
 * pending plan, the confirm page applies it — because the create happens deep
 * inside `applyAgendaPlan`'s locked transaction.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubMeetingRecurrence,
	meetings,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { upsertAgendasTool } = await import("#/server/mcp/tools/upsert-agendas");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { applyPendingPlan, loadPendingPlan } = await import(
	"#/server/agenda-plan-pending-logic"
);
const { adoptStandardAgenda } = await import("./club-agendas-logic");

/** A Tuesday far enough out that the suite never meets it. */
const TUESDAY = "2027-03-02";

describe.skipIf(!hasTestDb)(
	"an MCP-created meeting takes the club default",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
			await testDb.delete(meetings).where(eq(meetings.clubId, seed.clubId));
			await testDb
				.delete(roleDefinitions)
				.where(eq(roleDefinitions.id, seed.roleDefinitionId));
			await testDb
				.insert(roleDefinitions)
				.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: seed.clubId })));
			await testDb.insert(clubMeetingRecurrence).values({
				clubId: seed.clubId,
				mode: "interval",
				weekday: 2,
				intervalWeeks: 1,
				anchorDate: TUESDAY,
				timeOfDay: "19:00",
				// Paused, so the tool's top-up materialises nothing and the plan
				// CREATES the meeting.
				enabled: false,
			});
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("points the created meeting at a private copy of the default", async () => {
			const adopted = await adoptStandardAgenda({
				clubId: seed.clubId,
				actorMemberId: null,
			});
			const defaultId = adopted.templateId as string;

			const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
			await testDb
				.insert(apiTokens)
				.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
			const preview = (await upsertAgendasTool.handler(
				{
					clubId: seed.clubId,
					meetings: [{ date: TUESDAY, theme: "Harvest" }],
				},
				{ rawToken: raw },
			)) as unknown as { pendingId: string };
			const view = await loadPendingPlan({
				pendingId: preview.pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") throw new Error(view.status);
			const result = await applyPendingPlan({
				pendingId: preview.pendingId,
				userId: seed.adminUserId,
				planHash: view.planHash,
			});
			expect(result.ok).toBe(true);

			const [created] = await testDb
				.select({ id: meetings.id, templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.clubId, seed.clubId))
				.orderBy(asc(meetings.scheduledAt));
			expect(created?.templateId).toBeTruthy();
			expect(created?.templateId).not.toBe(defaultId);
			const [copy] = await testDb
				.select({
					meetingId: meetingTemplates.meetingId,
					key: meetingTemplates.key,
				})
				.from(meetingTemplates)
				.where(eq(meetingTemplates.id, created?.templateId as string));
			expect(copy).toEqual({ meetingId: created?.id, key: "standard" });

			// Slots from the default's declared roles: the adopted default declares
			// every stock role at its stock count.
			const slots = await testDb
				.select({ key: roleDefinitions.key })
				.from(roleSlots)
				.innerJoin(
					roleDefinitions,
					eq(roleDefinitions.id, roleSlots.roleDefinitionId),
				)
				.where(eq(roleSlots.meetingId, created?.id as string));
			const counts: Record<string, number> = {};
			for (const s of slots)
				counts[s.key ?? "?"] = (counts[s.key ?? "?"] ?? 0) + 1;
			expect(counts).toEqual(
				Object.fromEntries(ROLE_TEMPLATE.map((r) => [r.key, r.defaultCount])),
			);
		});
	},
);

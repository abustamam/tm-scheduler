/**
 * The two server fns behind the club default video-call link (#1534) cannot be
 * invoked from vitest (no session, no RPC layer), so this drives the gates they
 * call, with the same arguments `club-settings-authz.guard.test.ts` pins in the
 * source: `requireClubRole(…, ["admin"])` for the apply and
 * `requireClubAdminView` for the count. Also the `applyAgendaPlan` create path
 * copying the default.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiTokens, clubMeetingRecurrence, clubs, meetings } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { requireClubAdminView, requireClubRole } = await import(
	"#/server/guards"
);
const { archiveClub } = await import("#/server/onboarding-logic");
const { upsertAgendasTool } = await import("#/server/mcp/tools/upsert-agendas");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { applyPendingPlan, loadPendingPlan } = await import(
	"#/server/agenda-plan-pending-logic"
);

const DEFAULT = "https://zoom.example/j/club-default";

describe.skipIf(!hasTestDb)("club default link: gates and agenda plan", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		await testDb
			.update(clubs)
			.set({ defaultJoinUrl: DEFAULT })
			.where(eq(clubs.id, seed.clubId));
		await testDb.delete(meetings).where(eq(meetings.clubId, seed.clubId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("the apply gate refuses a non-admin member and lets the admin through", async () => {
		await expect(
			requireClubRole(seed.memberUserId, seed.clubId, ["admin"]),
		).rejects.toThrow();
		await expect(
			requireClubRole(seed.adminUserId, seed.clubId, ["admin"]),
		).resolves.toBeDefined();
	});

	it("the count gate refuses a non-admin member and lets the admin through", async () => {
		await expect(
			requireClubAdminView(seed.memberUserId, seed.clubId),
		).rejects.toThrow();
		await expect(
			requireClubAdminView(seed.adminUserId, seed.clubId),
		).resolves.toBeDefined();
	});

	it("an archived club refuses the admin on both gates", async () => {
		await archiveClub(seed.clubId);
		await expect(
			requireClubRole(seed.adminUserId, seed.clubId, ["admin"]),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
		await expect(
			requireClubAdminView(seed.adminUserId, seed.clubId),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	it("applyAgendaPlan's create path copies the club default onto the new meeting", async () => {
		await testDb.insert(clubMeetingRecurrence).values({
			clubId: seed.clubId,
			mode: "interval",
			weekday: 2,
			intervalWeeks: 1,
			anchorDate: "2027-03-02",
			timeOfDay: "19:00",
			enabled: false,
		});
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
		const preview = (await upsertAgendasTool.handler(
			{ clubId: seed.clubId, meetings: [{ date: "2027-03-02", theme: "X" }] },
			{ rawToken: raw },
		)) as unknown as { pendingId: string };
		const view = await loadPendingPlan({
			pendingId: preview.pendingId,
			userId: seed.adminUserId,
		});
		if (view.status !== "editable") throw new Error(`got ${view.status}`);
		const result = await applyPendingPlan({
			pendingId: preview.pendingId,
			userId: seed.adminUserId,
			planHash: view.planHash,
		});
		expect(result.applied).toMatchObject({ created: 1 });
		const rows = await testDb
			.select({ joinUrl: meetings.joinUrl })
			.from(meetings)
			.where(eq(meetings.clubId, seed.clubId));
		expect(rows.map((r) => r.joinUrl)).toEqual([DEFAULT]);
	});
});

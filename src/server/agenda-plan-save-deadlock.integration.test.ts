/**
 * A mixed agenda plan racing a save-as-club-template (#910 review, Codex P2).
 *
 * The plan CREATES a meeting — whose agenda read takes the club row FOR SHARE
 * (`startMeetingOnClubDefault`) — and then UPDATES existing meeting M. The save
 * locks M and then the club row FOR NO KEY UPDATE. Without a common first lock
 * those two orders deadlock: the plan holds the club SHARE and waits on M, the
 * save holds M and waits on the club. `applyAgendaPlan` now takes the club
 * write lock first, as the save already does, so the two serialise.
 *
 * The interleave is forced, not hoped for:
 *   1. a blocker holds the club row FOR SHARE;
 *   2. the save takes the club write lock and M, then parks on the club row
 *      behind the blocker;
 *   3. the plan starts. Without its club write lock it would create (taking
 *      the club SHARE, compatible with the blocker's) and then park on M
 *      behind the save; with it, it parks on the advisory lock the save holds;
 *   4. the blocker commits. Without the fix that is a deadlock Postgres
 *      detects in about a second and rolls one side back — a REJECTED promise
 *      here, so the case fails rather than hangs. With it, both complete.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubMeetingRecurrence,
	clubs,
	meetings,
	roleDefinitions,
} from "#/db/schema";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { ROLE_TEMPLATE } from "#/lib/role-template";
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

const { upsertAgendasTool } = await import("#/server/mcp/tools/upsert-agendas");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { applyPendingPlan, loadPendingPlan } = await import(
	"#/server/agenda-plan-pending-logic"
);
const { saveMeetingAgendaAsClubTemplate } = await import(
	"./meeting-templates-logic"
);

/** Two Tuesdays far enough out that the suite never meets them. */
const CREATE_DATE = "2027-03-02";
const EXISTING_DATE = "2027-03-09";

describe.skipIf(!hasTestDb)(
	"mixed agenda plan vs save-as-club-template",
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
				anchorDate: CREATE_DATE,
				timeOfDay: "19:00",
				// Paused, so the tool's top-up creates nothing of its own.
				enabled: false,
			});
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("completes both, in either order, with no deadlock", async () => {
			const [club] = await testDb
				.select({ timezone: clubs.timezone })
				.from(clubs)
				.where(eq(clubs.id, seed.clubId));
			const [existing] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: zonedWallTimeToUtc(
						`${EXISTING_DATE}T19:00`,
						club?.timezone ?? "America/Chicago",
					),
				})
				.returning({ id: meetings.id });
			const meetingId = existing?.id as string;

			// A pending plan: create one meeting, update the existing one.
			const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
			await testDb
				.insert(apiTokens)
				.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
			const preview = (await upsertAgendasTool.handler(
				{
					clubId: seed.clubId,
					meetings: [
						{ date: CREATE_DATE, theme: "New night" },
						{ date: EXISTING_DATE, theme: "Changed theme" },
					],
				},
				{ rawToken: raw },
			)) as unknown as { pendingId: string };
			const view = await loadPendingPlan({
				pendingId: preview.pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") throw new Error(view.status);

			// 1. The club row held FOR SHARE.
			const blocker = await openBlockingTx(async (tx) => {
				await tx
					.select({ id: clubs.id })
					.from(clubs)
					.where(eq(clubs.id, seed.clubId))
					.for("share");
			});
			// 2. The save: club write lock, meeting M, then parked on the club row.
			const saving = saveMeetingAgendaAsClubTemplate({
				mode: "new",
				meetingId,
				clubId: seed.clubId,
				actorMemberId: null,
				name: `Saved ${randomUUID().slice(0, 6)}`,
				description: null,
			});
			saving.catch(() => {});
			const saverPid = await waitForLockWait('from "clubs"', blocker.pid);
			// 3. The plan, parked behind the save (on its advisory lock with the
			//    fix, on meeting M without it).
			const applying = applyPendingPlan({
				pendingId: preview.pendingId,
				userId: seed.adminUserId,
				planHash: view.planHash,
			});
			applying.catch(() => {});
			await waitForLockWait("", saverPid);
			// 4. Release.
			await blocker.commit();

			const [saved, applied] = await Promise.allSettled([saving, applying]);
			expect(
				saved.status,
				String((saved as PromiseRejectedResult).reason),
			).toBe("fulfilled");
			expect(
				applied.status,
				String((applied as PromiseRejectedResult).reason),
			).toBe("fulfilled");
			if (applied.status === "fulfilled") expect(applied.value.ok).toBe(true);
			const [m] = await testDb
				.select({ theme: meetings.theme })
				.from(meetings)
				.where(eq(meetings.id, meetingId));
			expect(m?.theme).toBe("Changed theme");
		}, 30_000);
	},
);

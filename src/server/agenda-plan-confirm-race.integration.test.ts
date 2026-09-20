/**
 * The two rules that only run INSIDE the club lock (#808, AC10 and AC13).
 *
 * Both are unreachable serially. `applyPendingPlan`'s own pre-check answers a
 * plan that was already applied before the call started, and the planner blocks
 * a meeting that was already completed when the page rendered — so an assertion
 * written against an ordinary call passes whether the locked rule exists or not.
 * #806 shipped exactly that: its in-lock `applied_at` guard was reached by no
 * test, and deleting it left the whole suite green.
 *
 * Two things make these cases real. The `pg_locks` harness
 * (`src/test/club-lock.ts`) proves the apply is parked inside its transaction
 * before the world is moved underneath it. And each locked refusal says a
 * sentence only IT says — the pair is asserted in `src/lib/agenda-upsert.test.ts`
 * — so matching on the message cannot accidentally match the cheap check.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/agenda-plan-confirm-race.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiTokens, clubs, mcpPendingPlans, meetings } from "#/db/schema";
import {
	AGENDA_ALREADY_APPLIED_MESSAGE,
	AGENDA_APPLIED_WHILE_OPEN_MESSAGE,
	AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE,
} from "#/lib/agenda-upsert";
import { MEETING_LOCKED_BLOCKING_MESSAGE } from "#/lib/assign-roles-plan";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { awaitLockWaiter, holdClubLock } from "#/test/club-lock";
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

const TUESDAY = "2027-03-02";

describe.skipIf(!hasTestDb)("the agenda apply across the lock wait", () => {
	let seed: SeededClub;
	let timezone: string;
	let token: string;

	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	async function seedMeeting(date: string, time = "19:00"): Promise<string> {
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: zonedWallTimeToUtc(`${date}T${time}`, timezone),
				theme: "Old",
			})
			.returning({ id: meetings.id });
		if (!row) throw new Error("failed to seed a meeting");
		return row.id;
	}

	/** A pending plan and the hash its page would render. */
	async function pending(entries: Record<string, unknown>[]) {
		const { pendingId } = (await upsertAgendasTool.handler(
			{ clubId: seed.clubId, meetings: entries },
			{ rawToken: token },
		)) as { pendingId: string };
		const view = await loadPendingPlan({
			pendingId,
			userId: seed.adminUserId,
		});
		if (view.status !== "editable") {
			throw new Error(`expected an editable plan, got ${view.status}`);
		}
		return { pendingId, planHash: view.planHash };
	}

	async function themeOf(meetingId: string) {
		const [row] = await testDb
			.select({ theme: meetings.theme })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		return row?.theme ?? null;
	}

	beforeEach(async () => {
		seed = await seedClub();
		const [row] = await testDb
			.select({ timezone: clubs.timezone })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		timezone = row?.timezone ?? "America/Chicago";
		token = await mintToken(seed.adminUserId);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("positive control: the same setup applies when nothing interferes", async () => {
		// Without this, every case below could be passing because the harness
		// itself breaks the apply rather than because the guard fired.
		const meetingId = await seedMeeting(TUESDAY);
		const { pendingId, planHash } = await pending([
			{ date: TUESDAY, theme: "Harvest" },
		]);

		const lock = holdClubLock(seed.clubId);
		await lock.acquired;
		const applying = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
			planHash,
		});
		await awaitLockWaiter(seed.clubId);
		await lock.release();

		const result = await applying;
		expect(result.ok).toBe(true);
		expect(await themeOf(meetingId)).toBe("Harvest");
	});

	it("refuses a second apply INSIDE the lock, with a sentence only it says (AC10)", async () => {
		const meetingId = await seedMeeting(TUESDAY);
		const { pendingId, planHash } = await pending([
			{ date: TUESDAY, theme: "Harvest" },
		]);

		const lock = holdClubLock(seed.clubId);
		await lock.acquired;
		const applying = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
			planHash,
		});
		// Parked: past `resolvePending`, past the unlocked `applied_at` pre-check,
		// inside the transaction, waiting on the club lock.
		await awaitLockWaiter(seed.clubId);

		// The other click wins. Claiming the row directly is what a concurrent
		// apply's own claim would look like from in here.
		await testDb
			.update(mcpPendingPlans)
			.set({ appliedAt: new Date() })
			.where(eq(mcpPendingPlans.id, pendingId));
		await lock.release();

		const result = await applying;
		expect(result.ok).toBe(false);
		// THE assertion. This sentence is reachable from the locked guard and from
		// nowhere else — `agenda-upsert.test.ts` pins that it differs from the
		// pre-check's.
		expect(result.message).toBe(AGENDA_APPLIED_WHILE_OPEN_MESSAGE);
		expect(result.message).not.toBe(AGENDA_ALREADY_APPLIED_MESSAGE);
		// And nothing was written.
		expect(await themeOf(meetingId)).toBe("Old");
	});

	it("refuses a meeting completed during the wait, with its own sentence (AC13)", async () => {
		const meetingId = await seedMeeting(TUESDAY);
		const { pendingId, planHash } = await pending([
			{ date: TUESDAY, theme: "Harvest" },
		]);

		const lock = holdClubLock(seed.clubId);
		await lock.acquired;
		const applying = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
			planHash,
		});
		await awaitLockWaiter(seed.clubId);

		// The meeting is completed between the page rendering and the click, so
		// the plan-time blocking item never had a chance to fire.
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, meetingId));
		await lock.release();

		const result = await applying;
		expect(result.ok).toBe(false);
		expect(result.message).toBe(AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE);
		// NOT the plan-time sentence — the two refusals exist on purpose and a
		// test has to be able to tell which one ran.
		expect(result.message).not.toBe(MEETING_LOCKED_BLOCKING_MESSAGE);
		expect(await themeOf(meetingId)).toBe("Old");
	});

	it("re-plans inside the lock, so a concurrent edit is stale rather than overwritten", async () => {
		// The blocking check runs before the hash comparison (see
		// `agenda-plan-apply.ts`), so this case is what proves the hash still
		// fires for a change that blocks nothing.
		const meetingId = await seedMeeting(TUESDAY);
		const { pendingId, planHash } = await pending([
			{ date: TUESDAY, theme: "Harvest" },
		]);

		const lock = holdClubLock(seed.clubId);
		await lock.acquired;
		const applying = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
			planHash,
		});
		await awaitLockWaiter(seed.clubId);

		await testDb
			.update(meetings)
			.set({ theme: "Someone else's" })
			.where(eq(meetings.id, meetingId));
		await lock.release();

		const result = await applying;
		expect(result.ok).toBe(false);
		expect(result.message).toContain("changed");
		expect(await themeOf(meetingId)).toBe("Someone else's");
	});
});

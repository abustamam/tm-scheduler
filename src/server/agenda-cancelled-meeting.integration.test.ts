/**
 * `upsert_agendas` refuses a CANCELLED meeting, at all three places it could be
 * written (#1088).
 *
 * 1. The planner blocks the date with `MEETING_CANCELLED` (was a warning).
 * 2. The apply's in-lock re-plan refuses a meeting cancelled between the page
 *    rendering and the click, with a sentence only it says.
 * 3. `applyMeetingMetaPatch` itself refuses, in its own conditional UPDATE, and
 *    on an empty or unchanged patch too.
 *
 * The row-lock cases hold the meeting row from a second connection the way
 * `applyCancelMeeting` does, let the writer read the meeting as still scheduled
 * and park on its UPDATE, and only then commit the cancel — so the status the
 * writer READ and the status its UPDATE LANDS ON differ, and only the
 * condition inside the UPDATE can refuse it.
 *
 * Each refusal is reachable on its own here: the planner case goes through the
 * tool, the in-lock case parks the apply on the club lock (`src/test/club-lock.ts`)
 * so the plan-time block never had a chance to fire, and the writer cases call
 * the writer directly, which no planner stands in front of. Beside them, the
 * ALLOW cases: a scheduled meeting and a completed one behave as before.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, apiTokens, clubs, meetings } from "#/db/schema";
import {
	AGENDA_MEETING_CANCELLED_IN_LOCK_MESSAGE,
	AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE,
	AGENDA_STILL_BLOCKED_MESSAGE,
} from "#/lib/agenda-upsert";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { MEETING_LOCKED_BLOCKING_MESSAGE } from "#/lib/meeting-lifecycle";
import { awaitLockWaiter, holdClubLock } from "#/test/club-lock";
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
const { applyMeetingMetaPatch, applyWordOfTheDayUpdate } = await import(
	"#/server/meetings-logic"
);

/**
 * The UPDATE each writer issues, as `pg_stat_activity` shows it — what
 * `waitForLockWait` matches to prove the writer is parked on the meeting row
 * AFTER its unlocked read, rather than somewhere before it.
 */
const THEME_UPDATE = 'update "meetings" set "theme"';
const WOD_UPDATE = 'update "meetings" set "word_of_the_day"';

const TUESDAY = "2027-03-02";
const NEXT_TUESDAY = "2027-03-09";

describe("the in-lock cancellation sentence", () => {
	it("is distinct from the plan-time sentence and from the completed lock's", () => {
		// The in-lock refusal is only provable if it says something nothing else
		// says — see `AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE`.
		expect(AGENDA_MEETING_CANCELLED_IN_LOCK_MESSAGE).not.toBe(
			MEETING_CANCELLED_MESSAGE,
		);
		expect(AGENDA_MEETING_CANCELLED_IN_LOCK_MESSAGE).not.toBe(
			AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE,
		);
		expect(AGENDA_MEETING_CANCELLED_IN_LOCK_MESSAGE).not.toBe(
			AGENDA_STILL_BLOCKED_MESSAGE,
		);
	});
});

describe.skipIf(!hasTestDb)("a cancelled meeting and upsert_agendas", () => {
	let seed: SeededClub;
	let timezone: string;
	let token: string;

	async function seedMeeting(
		date: string,
		overrides: Partial<typeof meetings.$inferInsert> = {},
	): Promise<string> {
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: zonedWallTimeToUtc(`${date}T19:00`, timezone),
				theme: "Old",
				...overrides,
			})
			.returning({ id: meetings.id });
		if (!row) throw new Error("failed to seed a meeting");
		return row.id;
	}

	async function preview(entries: Record<string, unknown>[]) {
		return (await upsertAgendasTool.handler(
			{ clubId: seed.clubId, meetings: entries },
			{ rawToken: token },
		)) as unknown as {
			pendingId: string;
			blocking: { code: string; entryIndex?: number; message: string }[];
		};
	}

	async function themeOf(meetingId: string) {
		const [row] = await testDb
			.select({ theme: meetings.theme })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		return row?.theme ?? null;
	}

	async function clubMeetingCount() {
		return (
			await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(eq(meetings.clubId, seed.clubId))
		).length;
	}

	async function editsOf(meetingId: string) {
		return testDb
			.select({ id: activityLog.id })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "meeting_edit"),
					eq(activityLog.targetId, meetingId),
				),
			);
	}

	beforeEach(async () => {
		seed = await seedClub();
		const [row] = await testDb
			.select({ timezone: clubs.timezone })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		timezone = row?.timezone ?? "America/Chicago";
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
		token = raw;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	describe("at plan time (AC1)", () => {
		it("blocks the date with MEETING_CANCELLED, and the apply writes nothing", async () => {
			const meetingId = await seedMeeting(TUESDAY, { status: "cancelled" });
			const { pendingId, blocking } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
				{ date: NEXT_TUESDAY, time: "19:00", theme: "Autumn" },
			]);
			expect(blocking).toStrictEqual([
				expect.objectContaining({
					code: "MEETING_CANCELLED",
					entryIndex: 0,
					message: MEETING_CANCELLED_MESSAGE,
				}),
			]);

			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") throw new Error(view.status);
			const before = await clubMeetingCount();
			const result = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: view.planHash,
			});
			expect(result.ok).toBe(false);
			expect(await themeOf(meetingId)).toBe("Old");
			// Nor the other date's create: a blocked batch is refused whole.
			expect(await clubMeetingCount()).toBe(before);
			expect(await editsOf(meetingId)).toStrictEqual([]);
		});

		it("still blocks a completed meeting with MEETING_LOCKED and its own sentence (AC4)", async () => {
			await seedMeeting(TUESDAY, { status: "completed" });
			const { blocking } = await preview([{ date: TUESDAY, theme: "Harvest" }]);
			expect(blocking).toStrictEqual([
				expect.objectContaining({
					code: "MEETING_LOCKED",
					message: MEETING_LOCKED_BLOCKING_MESSAGE,
				}),
			]);
		});
	});

	describe("inside the apply's lock (AC2)", () => {
		async function applyAcrossWait(
			meetingId: string,
			status: "cancelled" | "completed" | null,
		) {
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
				{ date: NEXT_TUESDAY, time: "19:00", theme: "Autumn" },
			]);
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") throw new Error(view.status);
			expect(view.blocking).toStrictEqual([]);

			const lock = holdClubLock(seed.clubId);
			await lock.acquired;
			const applying = applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: view.planHash,
			});
			// Parked inside its transaction, past every up-front check.
			await awaitLockWaiter(seed.clubId);
			if (status) {
				await testDb
					.update(meetings)
					.set({ status })
					.where(eq(meetings.id, meetingId));
			}
			await lock.release();
			return applying;
		}

		it("positive control: the same setup applies when nothing interferes", async () => {
			const meetingId = await seedMeeting(TUESDAY);
			const before = await clubMeetingCount();
			const result = await applyAcrossWait(meetingId, null);
			expect(result.ok).toBe(true);
			expect(await themeOf(meetingId)).toBe("Harvest");
			expect(await clubMeetingCount()).toBe(before + 1);
		});

		it("refuses a meeting cancelled during the wait, with its own sentence, and writes nothing", async () => {
			const meetingId = await seedMeeting(TUESDAY);
			const before = await clubMeetingCount();
			const result = await applyAcrossWait(meetingId, "cancelled");
			expect(result.ok).toBe(false);
			expect(result.message).toBe(AGENDA_MEETING_CANCELLED_IN_LOCK_MESSAGE);
			expect(await themeOf(meetingId)).toBe("Old");
			expect(await clubMeetingCount()).toBe(before);
			expect(await editsOf(meetingId)).toStrictEqual([]);
		});

		it("says the completed lock's sentence when one date completed and another was cancelled", async () => {
			// Precedence, pinned: the lock's sentence wins over the cancellation's.
			const completing = await seedMeeting(TUESDAY);
			const cancelling = await seedMeeting(NEXT_TUESDAY);
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
				{ date: NEXT_TUESDAY, theme: "Autumn" },
			]);
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") throw new Error(view.status);
			const lock = holdClubLock(seed.clubId);
			await lock.acquired;
			const applying = applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: view.planHash,
			});
			await awaitLockWaiter(seed.clubId);
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, completing));
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, cancelling));
			await lock.release();
			const result = await applying;
			expect(result.ok).toBe(false);
			expect(result.message).toBe(AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE);
			expect(await themeOf(cancelling)).toBe("Old");
		});

		it("keeps the completed lock's own sentence for a meeting completed during the wait (AC4)", async () => {
			const meetingId = await seedMeeting(TUESDAY);
			const result = await applyAcrossWait(meetingId, "completed");
			expect(result.ok).toBe(false);
			expect(result.message).toBe(AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE);
			expect(await themeOf(meetingId)).toBe("Old");
		});
	});

	describe("applyMeetingMetaPatch called directly (AC3)", () => {
		it("refuses a cancelled meeting and writes no row and no meeting_edit", async () => {
			const meetingId = await seedMeeting(TUESDAY, { status: "cancelled" });
			await expect(
				applyMeetingMetaPatch({
					meetingId,
					actorMemberId: null,
					theme: "Harvest",
					location: "Somewhere new",
				}),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			expect(await themeOf(meetingId)).toBe("Old");
			expect(await editsOf(meetingId)).toStrictEqual([]);
		});

		it("refuses an EMPTY patch on a cancelled meeting rather than reporting success", async () => {
			const meetingId = await seedMeeting(TUESDAY, { status: "cancelled" });
			await expect(
				applyMeetingMetaPatch({ meetingId, actorMemberId: null }),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			expect(await editsOf(meetingId)).toStrictEqual([]);
		});

		it("refuses an UNCHANGED patch on a cancelled meeting", async () => {
			const meetingId = await seedMeeting(TUESDAY, { status: "cancelled" });
			await expect(
				applyMeetingMetaPatch({ meetingId, actorMemberId: null, theme: "Old" }),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			expect(await editsOf(meetingId)).toStrictEqual([]);
		});

		it("still writes a scheduled meeting and logs the edit (AC4)", async () => {
			const meetingId = await seedMeeting(TUESDAY);
			await applyMeetingMetaPatch({
				meetingId,
				actorMemberId: null,
				theme: "Harvest",
			});
			expect(await themeOf(meetingId)).toBe("Harvest");
			expect(await editsOf(meetingId)).toHaveLength(1);
			// And an empty patch is still a quiet success there.
			await expect(
				applyMeetingMetaPatch({ meetingId, actorMemberId: null }),
			).resolves.toStrictEqual({ clubId: seed.clubId });
		});

		it("still writes a completed meeting, as it did before (AC4)", async () => {
			// The writer has never enforced the completed lock itself — the
			// resolvers and the planner do. #1088 does not change that.
			const meetingId = await seedMeeting(TUESDAY, { status: "completed" });
			await applyMeetingMetaPatch({
				meetingId,
				actorMemberId: null,
				theme: "Harvest",
			});
			expect(await themeOf(meetingId)).toBe("Harvest");
		});
	});

	describe("a cancel committing between the read and the UPDATE", () => {
		/** Hold the meeting row, as `applyCancelMeeting` does, with `work` applied. */
		function holdMeetingRow(meetingId: string, change: "cancel" | "delete") {
			return openBlockingTx(async (tx) => {
				if (change === "cancel") {
					await tx
						.update(meetings)
						.set({ status: "cancelled" })
						.where(eq(meetings.id, meetingId));
				} else {
					await tx.delete(meetings).where(eq(meetings.id, meetingId));
				}
			});
		}

		it("the apply: comes back as the blocked result with a fresh plan, and writes nothing in the batch", async () => {
			const meetingId = await seedMeeting(TUESDAY);
			// The create comes FIRST, so it has already been inserted when the
			// update is refused — proving the refusal rolls the whole batch back.
			const { pendingId } = await preview([
				{ date: NEXT_TUESDAY, time: "19:00", theme: "Autumn" },
				{ date: TUESDAY, theme: "Harvest" },
			]);
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") throw new Error(view.status);
			const before = await clubMeetingCount();

			const blocker = await holdMeetingRow(meetingId, "cancel");
			const applying = applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: view.planHash,
			});
			// Parked on the meeting row inside `applyMeetingMetaPatch` — past the
			// re-plan, which read the meeting as scheduled and so blocked nothing.
			await waitForLockWait(THEME_UPDATE, blocker.pid);
			await blocker.commit();

			const result = await applying;
			expect(result.ok).toBe(false);
			expect(result.message).toBe(AGENDA_MEETING_CANCELLED_IN_LOCK_MESSAGE);
			// The refreshed plan, now explaining the date.
			if (result.view.status !== "editable")
				throw new Error(result.view.status);
			expect(result.view.blocking.map((b) => b.code)).toStrictEqual([
				"MEETING_CANCELLED",
			]);
			expect(await themeOf(meetingId)).toBe("Old");
			expect(await clubMeetingCount()).toBe(before);
			expect(await editsOf(meetingId)).toStrictEqual([]);
		});

		it("applyMeetingMetaPatch: refuses in its UPDATE what its read saw as scheduled", async () => {
			const meetingId = await seedMeeting(TUESDAY);
			const blocker = await holdMeetingRow(meetingId, "cancel");
			const writing = applyMeetingMetaPatch({
				meetingId,
				actorMemberId: null,
				theme: "Harvest",
			});
			writing.catch(() => {});
			await waitForLockWait(THEME_UPDATE, blocker.pid);
			await blocker.commit();
			await expect(writing).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			expect(await themeOf(meetingId)).toBe("Old");
			expect(await editsOf(meetingId)).toStrictEqual([]);
		});

		it("applyMeetingMetaPatch: a meeting DELETED in that window is not-found, not cancelled", async () => {
			const meetingId = await seedMeeting(TUESDAY);
			const blocker = await holdMeetingRow(meetingId, "delete");
			const writing = applyMeetingMetaPatch({
				meetingId,
				actorMemberId: null,
				theme: "Harvest",
			});
			writing.catch(() => {});
			await waitForLockWait(THEME_UPDATE, blocker.pid);
			await blocker.commit();
			await expect(writing).rejects.toThrow("Meeting not found.");
		});

		it("applyWordOfTheDayUpdate: refuses in its UPDATE what its read saw as scheduled", async () => {
			const meetingId = await seedMeeting(TUESDAY);
			const blocker = await holdMeetingRow(meetingId, "cancel");
			const writing = applyWordOfTheDayUpdate({
				meetingId,
				actorMemberId: null,
				wordOfTheDay: "Ebullient",
			});
			writing.catch(() => {});
			await waitForLockWait(WOD_UPDATE, blocker.pid);
			await blocker.commit();
			await expect(writing).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			const [row] = await testDb
				.select({ word: meetings.wordOfTheDay })
				.from(meetings)
				.where(eq(meetings.id, meetingId));
			expect(row?.word).toBeNull();
			expect(await editsOf(meetingId)).toStrictEqual([]);
		});
	});

	describe("the narrow Word of the Day / Table Topics writer", () => {
		it("refuses a cancelled meeting, empty patch included, and logs nothing", async () => {
			const meetingId = await seedMeeting(TUESDAY, { status: "cancelled" });
			await expect(
				applyWordOfTheDayUpdate({
					meetingId,
					actorMemberId: null,
					wordOfTheDay: "Ebullient",
				}),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			await expect(
				applyWordOfTheDayUpdate({ meetingId, actorMemberId: null }),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			expect(await editsOf(meetingId)).toStrictEqual([]);
		});

		it("still writes a scheduled meeting and logs the edit", async () => {
			const meetingId = await seedMeeting(TUESDAY);
			await applyWordOfTheDayUpdate({
				meetingId,
				actorMemberId: null,
				wordOfTheDay: "Ebullient",
			});
			const [row] = await testDb
				.select({ word: meetings.wordOfTheDay })
				.from(meetings)
				.where(eq(meetings.id, meetingId));
			expect(row?.word).toBe("Ebullient");
			expect(await editsOf(meetingId)).toHaveLength(1);
		});
	});
});

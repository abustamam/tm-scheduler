/**
 * DB-backed tests for cancelling and restoring a meeting (#1057).
 *
 * Cancel sets `status = cancelled` and touches no `role_slots` row; restore
 * sets it back with the assignments exactly as they were. Every member-facing
 * write on a cancelled meeting is refused with `MEETING_CANCELLED_MESSAGE`,
 * the next schedule top-up does not recreate the cancelled date, and the
 * officer can find the meeting again through `loadCancelledMeetings`.
 *
 * The server fns (`cancelMeeting` / `restoreMeeting`) cannot be invoked from
 * vitest, so the role gate is the one thing not exercised here; the MCP tools'
 * suite covers admin / officer / member through `authorizeTokenForMeeting`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-cancel.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubMeetingRecurrence,
	meetingAttendancePlan,
	meetings,
	roleSlots,
} from "#/db/schema";
import {
	buildCancellationNotice,
	holdersFromSlots,
	MEETING_ALREADY_CANCELLED_MESSAGE,
	MEETING_CANCEL_COMPLETED_MESSAGE,
	MEETING_CANCEL_PAST_MESSAGE,
	MEETING_CANCELLED_MESSAGE,
	MEETING_NOT_CANCELLED_MESSAGE,
	MEETING_RESTORE_PAST_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyCancelMeeting, applyRestoreMeeting, loadCancelledMeetings } =
	await import("./meetings-logic");
const { claimSlotCore, reassignSlotCore } = await import("./slots-logic");
const { SELF_SERVICE_RUNGS, clearPlanStatus, setPlanStatus } = await import(
	"./attendance-plan-logic"
);
const { castVote } = await import("./voting-logic");
const { loadPublicLineupBlastData } = await import("./lineup-blast-logic");
const { loadMeetingSlots } = await import("./meeting-slots-logic");
const { ensureScheduleToppedUp } = await import("./schedule-topup-logic");
const { McpError } = await import("./mcp/errors");

const DAY = 24 * 60 * 60 * 1000;

async function meetingStatus(meetingId: string) {
	const row = await testDb.query.meetings.findFirst({
		where: eq(meetings.id, meetingId),
		columns: { status: true },
	});
	return row?.status;
}

async function setScheduledAt(meetingId: string, at: Date) {
	await testDb
		.update(meetings)
		.set({ scheduledAt: at })
		.where(eq(meetings.id, meetingId));
}

async function setStatus(
	meetingId: string,
	status: "scheduled" | "cancelled" | "completed",
) {
	await testDb
		.update(meetings)
		.set({ status })
		.where(eq(meetings.id, meetingId));
}

/** Every slot row on the meeting, as the thing a cancel must not change. */
async function slotRows(meetingId: string) {
	return testDb
		.select({
			id: roleSlots.id,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			assignedGuestId: roleSlots.assignedGuestId,
			claimedAt: roleSlots.claimedAt,
			speechId: roleSlots.speechId,
		})
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(roleSlots.id);
}

/** `meeting_edit` rows for the meeting, oldest first, with their `change`. */
async function meetingEdits(clubId: string, meetingId: string) {
	const rows = await testDb
		.select({
			actorMemberId: activityLog.actorMemberId,
			detail: activityLog.detail,
		})
		.from(activityLog)
		.where(
			and(
				eq(activityLog.clubId, clubId),
				eq(activityLog.action, "meeting_edit"),
				eq(activityLog.targetId, meetingId),
			),
		)
		.orderBy(activityLog.createdAt);
	return rows.map((r) => ({
		actorMemberId: r.actorMemberId,
		change: (r.detail as { change?: string } | null)?.change,
	}));
}

describe.skipIf(!hasTestDb)("cancel and restore a meeting (#1057)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	describe("the status change", () => {
		it("cancels a future scheduled meeting and leaves every role_slots row as it was", async () => {
			// A held role, so "kept" is a claim about a real assignment.
			await testDb
				.update(roleSlots)
				.set({
					status: "claimed",
					assignedMemberId: club.memberId,
					claimedAt: new Date(),
				})
				.where(eq(roleSlots.id, club.slotId));
			const before = await slotRows(club.meetingId);

			const result = await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});

			expect(result).toEqual({ clubId: club.clubId });
			expect(await meetingStatus(club.meetingId)).toBe("cancelled");
			expect(await slotRows(club.meetingId)).toEqual(before);
		});

		it("restore puts it back to scheduled with the assignments identical", async () => {
			await testDb
				.update(roleSlots)
				.set({ status: "claimed", assignedMemberId: club.memberId })
				.where(eq(roleSlots.id, club.slotId));
			const before = await slotRows(club.meetingId);

			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await applyRestoreMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});

			expect(await meetingStatus(club.meetingId)).toBe("scheduled");
			expect(await slotRows(club.meetingId)).toEqual(before);
		});

		it("writes one meeting_edit row per change, naming the change and the actor", async () => {
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await applyRestoreMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			expect(await meetingEdits(club.clubId, club.meetingId)).toEqual([
				{ actorMemberId: club.adminMemberId, change: "cancel" },
				{ actorMemberId: club.adminMemberId, change: "restore" },
			]);
		});

		it("a refused cancel writes nothing to the activity log", async () => {
			await setStatus(club.meetingId, "completed");
			await expect(
				applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_CANCEL_COMPLETED_MESSAGE);
			expect(await meetingEdits(club.clubId, club.meetingId)).toEqual([]);
		});

		it("today's meeting CAN be cancelled (club-local day granularity)", async () => {
			// The same instant as the check's clock is the same club-local day in
			// every zone, so this is "today" wherever the suite runs.
			await setScheduledAt(club.meetingId, new Date());
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			expect(await meetingStatus(club.meetingId)).toBe("cancelled");
		});
	});

	describe("cancel refusals, in order", () => {
		it("refuses a completed meeting, and says so before looking at the date", async () => {
			await setScheduledAt(club.meetingId, new Date(Date.now() - 3 * DAY));
			await setStatus(club.meetingId, "completed");
			await expect(
				applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_CANCEL_COMPLETED_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("completed");
		});

		it("refuses a meeting whose club-local date has passed", async () => {
			await setScheduledAt(club.meetingId, new Date(Date.now() - 3 * DAY));
			await expect(
				applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_CANCEL_PAST_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("scheduled");
		});

		it("refuses cancelling twice, with the already-cancelled sentence, writing nothing", async () => {
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await expect(
				applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_ALREADY_CANCELLED_MESSAGE);
			expect(await meetingEdits(club.clubId, club.meetingId)).toHaveLength(1);
		});

		it("a cancelled meeting whose date has passed answers for the date first", async () => {
			// The order the issue states: completed, then past, then already
			// cancelled. A past cancelled meeting is past before it is cancelled.
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await setScheduledAt(club.meetingId, new Date(Date.now() - 3 * DAY));
			await expect(
				applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_CANCEL_PAST_MESSAGE);
		});

		it("rejects an unknown meeting", async () => {
			await expect(
				applyCancelMeeting({
					meetingId: "00000000-0000-4000-8000-000000000000",
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow("Meeting not found.");
		});
	});

	describe("restore refusals, in order", () => {
		it("refuses a cancelled meeting whose date has passed", async () => {
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await setScheduledAt(club.meetingId, new Date(Date.now() - 3 * DAY));
			await expect(
				applyRestoreMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_RESTORE_PAST_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("cancelled");
		});

		it("refuses a meeting that is not cancelled, writing nothing", async () => {
			await expect(
				applyRestoreMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_NOT_CANCELLED_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("scheduled");
			expect(await meetingEdits(club.clubId, club.meetingId)).toEqual([]);
		});

		it("refuses a completed meeting as not cancelled, never as restorable", async () => {
			await setStatus(club.meetingId, "completed");
			await expect(
				applyRestoreMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_NOT_CANCELLED_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("completed");
		});
	});

	describe("member-facing writes on a cancelled meeting", () => {
		beforeEach(async () => {
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
		});

		it("refuses a self-claim, and the slot stays open", async () => {
			await expect(
				testDb.transaction((tx) =>
					claimSlotCore(tx, {
						slotId: club.slotId,
						memberId: club.memberId,
						actorMemberId: club.memberId,
						proof: "session",
					}),
				),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			const [slot] = await slotRows(club.meetingId);
			expect(slot?.status).toBe("open");
			expect(slot?.assignedMemberId).toBeNull();
		});

		it("refuses a claim made on a member's BEHALF — the claim statement's own guard", async () => {
			// MEASURED: a self-claim is refused twice over, because
			// `markComingOnSelfClaim` writes a plan row in the same transaction
			// and the plan seam refuses with the same sentence — so dropping the
			// claim's `meetingNotCancelled` predicate left the case above green.
			// An officer claiming for someone else never reaches the plan seam
			// (`markComingOnSelfClaim` returns early when actor ≠ member), so this
			// is the case the UPDATE's own WHERE has to hold alone.
			await expect(
				testDb.transaction((tx) =>
					claimSlotCore(tx, {
						slotId: club.slotId,
						memberId: club.memberId,
						actorMemberId: club.adminMemberId,
						proof: "session",
					}),
				),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			const [slot] = await slotRows(club.meetingId);
			expect(slot?.status).toBe("open");
			expect(slot?.assignedMemberId).toBeNull();
		});

		it("refuses a reassign / assign-to-member, and the slot is unchanged", async () => {
			await expect(
				testDb.transaction((tx) =>
					reassignSlotCore(tx, {
						slotId: club.slotId,
						memberId: club.memberId,
						actorMemberId: club.adminMemberId,
						proof: "session",
					}),
				),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			const [slot] = await slotRows(club.meetingId);
			expect(slot?.status).toBe("open");
			expect(slot?.assignedMemberId).toBeNull();
		});

		it("refuses a planned-attendance write, and no plan row appears", async () => {
			await expect(
				setPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					status: "coming",
					actorMemberId: club.memberId,
				}),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			expect(
				await testDb
					.select({ id: meetingAttendancePlan.id })
					.from(meetingAttendancePlan)
					.where(eq(meetingAttendancePlan.meetingId, club.meetingId)),
			).toEqual([]);
		});

		it("refuses clearing a planned-attendance answer", async () => {
			await expect(
				clearPlanStatus(testDb, {
					memberId: club.memberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
					actorMemberId: club.memberId,
					onlyFrom: SELF_SERVICE_RUNGS,
				}),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
		});

		it("refuses a ballot, before any eligibility or window question", async () => {
			// No vote session exists and digital voting is off by default, so a
			// cast that got PAST the cancelled check would say something else.
			await expect(
				castVote({
					meetingId: club.meetingId,
					category: "best_speaker",
					voter: { kind: "member", id: club.memberId },
					candidate: { kind: "member", id: club.memberId },
				}),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
		});

		it("refuses the public lineup blast loader with the same sentence, as an McpError", async () => {
			// An `McpError` so the connector gets a code rather than INTERNAL;
			// the browser's server fn rethrows it and the sheet reads `.message`.
			const err = await loadPublicLineupBlastData(club.meetingId).catch(
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(McpError);
			expect((err as InstanceType<typeof McpError>).message).toBe(
				MEETING_CANCELLED_MESSAGE,
			);
			expect((err as InstanceType<typeof McpError>).code).toBe("LOCKED");
		});

		it("accepts the same claim again once the meeting is restored", async () => {
			await applyRestoreMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await testDb.transaction((tx) =>
				claimSlotCore(tx, {
					slotId: club.slotId,
					memberId: club.memberId,
					actorMemberId: club.memberId,
					proof: "session",
				}),
			);
			const [slot] = await slotRows(club.meetingId);
			expect(slot?.status).toBe("claimed");
			expect(slot?.assignedMemberId).toBe(club.memberId);
		});
	});

	describe("the race the lock decides", () => {
		it("a claim that committed BEFORE the cancel is kept, and the notice names it", async () => {
			await testDb.transaction((tx) =>
				claimSlotCore(tx, {
					slotId: club.slotId,
					memberId: club.memberId,
					actorMemberId: club.memberId,
					proof: "session",
				}),
			);
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});

			const [slot] = await slotRows(club.meetingId);
			expect(slot?.status).toBe("claimed");
			expect(slot?.assignedMemberId).toBe(club.memberId);

			// What the MCP tool and the sheet build the notice from: the SAME
			// loader the agenda renders, names only.
			const holders = holdersFromSlots(await loadMeetingSlots(club.meetingId));
			expect(holders).toEqual([
				{ roleName: "Timer", name: "Member User", email: null },
			]);
			expect(
				buildCancellationNotice({
					clubName: "Test Club",
					scheduledAt: new Date(),
					timezone: "America/Chicago",
					holders,
				}).text,
			).toContain("Timer: Member User");
		});
	});

	describe("the schedule top-up", () => {
		it("does not recreate a meeting on the cancelled date, and adds its replacement at the far end", async () => {
			// Start from zero meetings, under a weekly rule keeping two ahead.
			await testDb.delete(meetings).where(eq(meetings.clubId, club.clubId));
			await testDb.insert(clubMeetingRecurrence).values({
				clubId: club.clubId,
				mode: "interval",
				weekday: 4,
				intervalWeeks: 1,
				anchorDate: "2026-01-01",
				timeOfDay: "18:45",
				keepAhead: 2,
				enabled: true,
			});
			const now = new Date();
			expect(await ensureScheduleToppedUp(club.clubId, now)).toEqual({
				created: 2,
			});
			const [first] = await testDb
				.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
				.from(meetings)
				.where(eq(meetings.clubId, club.clubId))
				.orderBy(meetings.scheduledAt);
			if (!first) throw new Error("top-up created nothing");

			await applyCancelMeeting({
				meetingId: first.id,
				actorMemberId: club.adminMemberId,
			});
			// One short of keep-ahead now, so the top-up adds exactly one...
			expect(await ensureScheduleToppedUp(club.clubId, now)).toEqual({
				created: 1,
			});
			const all = await testDb
				.select({
					id: meetings.id,
					scheduledAt: meetings.scheduledAt,
					status: meetings.status,
				})
				.from(meetings)
				.where(eq(meetings.clubId, club.clubId))
				.orderBy(meetings.scheduledAt);
			// ...and it is NOT on the cancelled date: that date still holds the
			// one cancelled row and nothing else.
			const onCancelledDate = all.filter(
				(m) => m.scheduledAt.getTime() === first.scheduledAt.getTime(),
			);
			expect(onCancelledDate).toEqual([
				{ id: first.id, scheduledAt: first.scheduledAt, status: "cancelled" },
			]);
			expect(all.filter((m) => m.status === "scheduled")).toHaveLength(2);
			// The replacement is after everything that was there before.
			expect(all.at(-1)?.scheduledAt.getTime()).toBeGreaterThan(
				first.scheduledAt.getTime(),
			);
			// Idempotent: full again, so a third run adds nothing.
			expect(await ensureScheduleToppedUp(club.clubId, now)).toEqual({
				created: 0,
			});
		});
	});

	describe("loadCancelledMeetings", () => {
		it("lists a cancelled meeting from today onward, and not a scheduled or a past one", async () => {
			// A second meeting, cancelled, that is then moved into the past.
			const [past] = await testDb
				.insert(meetings)
				.values({
					clubId: club.clubId,
					scheduledAt: new Date(Date.now() + 14 * DAY),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			if (!past) throw new Error("insert failed");
			await applyCancelMeeting({
				meetingId: past.id,
				actorMemberId: club.adminMemberId,
			});
			await setScheduledAt(past.id, new Date(Date.now() - 3 * DAY));

			// The seeded meeting is scheduled: absent.
			expect(await loadCancelledMeetings(club.clubId)).toEqual([]);

			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			const rows = await loadCancelledMeetings(club.clubId);
			expect(rows.map((r) => r.id)).toEqual([club.meetingId]);
			expect(rows[0]?.timezone).toBe("America/Chicago");
			expect(new Date(rows[0]?.scheduledAt ?? 0).getTime()).toBeGreaterThan(
				Date.now(),
			);
		});

		it("includes a cancelled meeting earlier today (still restorable)", async () => {
			await setScheduledAt(club.meetingId, new Date());
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			// A moment ago is still today in the club's zone when `now` is the
			// same clock, so the start-of-day floor admits it.
			expect(
				(await loadCancelledMeetings(club.clubId)).map((r) => r.id),
			).toEqual([club.meetingId]);
		});
	});
});

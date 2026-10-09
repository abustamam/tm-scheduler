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
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubMeetingRecurrence,
	guests,
	meetingAttendancePlan,
	meetings,
	meetingVoteSessions,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	buildCancellationNotice,
	holdersFromSlots,
	MEETING_ALREADY_CANCELLED_MESSAGE,
	MEETING_CANCEL_COMPLETED_MESSAGE,
	MEETING_CANCEL_PAST_MESSAGE,
	MEETING_CANCELLED_MESSAGE,
	MEETING_NOT_CANCELLED_MESSAGE,
	MEETING_REOPEN_NOT_COMPLETED_MESSAGE,
	MEETING_RESTORE_PAST_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
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

const {
	applyCancelMeeting,
	applyCompleteMeeting,
	applyReopenMeeting,
	applyRestoreMeeting,
	loadCancelledMeetings,
} = await import("./meetings-logic");
const { claimSlotCore, reassignSlotCore, releaseSlotCore } = await import(
	"./slots-logic"
);
const { applyAssignGuestToSlot } = await import("./guests-logic");
const { applyMemberRemove, applySetMemberStatus } = await import(
	"./members-logic"
);
const { SELF_SERVICE_RUNGS, clearPlanStatus, setPlanStatus } = await import(
	"./attendance-plan-logic"
);
const { castVote, joinBallotAsGuest } = await import("./voting-logic");
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

		it("a meeting that has not started yet can be cancelled, minutes before its start", async () => {
			// The maintainer's rule on #1084: the boundary is the meeting's START,
			// not its club-local day. The faked-clock cases below pin the instant
			// itself and the cases either side of a day boundary.
			await setScheduledAt(club.meetingId, new Date(Date.now() + 10 * 60_000));
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			expect(await meetingStatus(club.meetingId)).toBe("cancelled");
		});

		it("a meeting that started minutes ago is refused, though its day is not over", async () => {
			await setScheduledAt(club.meetingId, new Date(Date.now() - 10 * 60_000));
			await expect(
				applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_CANCEL_PAST_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("scheduled");
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

		it("refuses a meeting whose date has passed (it has long since started)", async () => {
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
			// claim's `meetingAcceptsWrite` predicate left the case above green.
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

		it("refuses a release / clear, keeping the holder AND the speech (review of #1084)", async () => {
			// A clear is the one write a restore could not undo: it drops
			// `speech_id`, and re-claiming mints a new speech row (ADR-0009). A
			// speaker slot held by the member with a linked speech, on the already
			// cancelled meeting, so "kept" is a claim about both columns.
			const [speakerRole] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: club.personId, title: "Ice Breaker" })
				.returning({ id: speeches.id });
			if (!speakerRole || !speech) throw new Error("fixture insert failed");
			const [held] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: club.meetingId,
					roleDefinitionId: speakerRole.id,
					status: "claimed",
					assignedMemberId: club.memberId,
					speechId: speech.id,
				})
				.returning({ id: roleSlots.id });
			if (!held) throw new Error("fixture insert failed");

			await expect(
				releaseSlotCore(testDb, {
					slotId: held.id,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			const row = (await slotRows(club.meetingId)).find(
				(s) => s.id === held.id,
			);
			expect(row?.status).toBe("claimed");
			expect(row?.assignedMemberId).toBe(club.memberId);
			expect(row?.speechId).toBe(speech.id);
		});

		it("refuses a guest assignment, and the slot is unchanged (review of #1084)", async () => {
			const [guest] = await testDb
				.insert(guests)
				.values({ clubId: club.clubId, name: "Visiting Vera" })
				.returning({ id: guests.id });
			if (!guest) throw new Error("fixture insert failed");
			await expect(
				applyAssignGuestToSlot({
					slotId: club.slotId,
					guestId: guest.id,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			const [slot] = await slotRows(club.meetingId);
			expect(slot?.status).toBe("open");
			expect(slot?.assignedGuestId).toBeNull();
			expect(slot?.assignedMemberId).toBeNull();
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
			// Cancelled while it was still ahead, then its start passed: a meeting
			// that has STARTED can no longer be cancelled, so the state is set
			// directly rather than through `applyCancelMeeting`.
			await setScheduledAt(club.meetingId, new Date());
			await setStatus(club.meetingId, "cancelled");
			// A moment ago is still today in the club's zone when `now` is the
			// same clock, so the start-of-day floor admits it.
			expect(
				(await loadCancelledMeetings(club.clubId)).map((r) => r.id),
			).toEqual([club.meetingId]);
		});
	});

	// Review of #1084, finding A: the two status writers that predate
	// cancellation decided nothing from the status they found. A stale tab's
	// Complete closed out a cancelled meeting (and froze a number onto it), and
	// Reopen put a past cancelled meeting back around restore's day rule.
	describe("complete and reopen respect cancellation", () => {
		async function meetingNumber(meetingId: string) {
			const row = await testDb.query.meetings.findFirst({
				where: eq(meetings.id, meetingId),
				columns: { meetingNumber: true },
			});
			return row?.meetingNumber;
		}

		it("complete refuses today's cancelled meeting: it stays cancelled, unnumbered, with no completed row", async () => {
			// Today, so the date rule would ADMIT it — the refusal must be the
			// cancellation's and nothing else's. Cancelled while it was still in
			// the future, then moved to now: a started meeting cannot be cancelled.
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await setScheduledAt(club.meetingId, new Date());
			await expect(
				applyCompleteMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("cancelled");
			expect(await meetingNumber(club.meetingId)).toBeNull();
			expect(
				(await meetingEdits(club.clubId, club.meetingId)).map((e) => e.change),
			).toEqual(["cancel"]);
		});

		it("reopen refuses a cancelled future meeting and points at Restore", async () => {
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await expect(
				applyReopenMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_REOPEN_NOT_COMPLETED_MESSAGE);
			expect(MEETING_REOPEN_NOT_COMPLETED_MESSAGE).toMatch(/Restore/);
			expect(await meetingStatus(club.meetingId)).toBe("cancelled");
		});

		it("reopen refuses a PAST cancelled meeting, so restore's day rule is not bypassed", async () => {
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await setScheduledAt(club.meetingId, new Date(Date.now() - 3 * DAY));
			await expect(
				applyReopenMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_REOPEN_NOT_COMPLETED_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("cancelled");
			expect(
				(await meetingEdits(club.clubId, club.meetingId)).map((e) => e.change),
			).toEqual(["cancel"]);
		});

		it("reopen refuses a meeting that is merely scheduled, writing nothing", async () => {
			await expect(
				applyReopenMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_REOPEN_NOT_COMPLETED_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("scheduled");
			expect(await meetingEdits(club.clubId, club.meetingId)).toEqual([]);
		});

		it("a Complete racing a cancel waits on the meeting lock, then refuses the cancelled row", async () => {
			// The reproduced bug, as an interleaving rather than a sequence: a
			// cancel holding the meeting row with its status already written and
			// not yet committed, and a stale tab's Complete arriving underneath it.
			// A serial test cannot tell a locked read from an unlocked one — both
			// see `cancelled` once the cancel has committed. Here the unlocked read
			// sees `scheduled`, its UPDATE parks behind the row and then lands, and
			// the meeting ends up `completed`.
			await setScheduledAt(club.meetingId, new Date());
			const cancel = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from meetings where id = ${club.meetingId} for no key update`,
				);
				await tx
					.update(meetings)
					.set({ status: "cancelled" })
					.where(eq(meetings.id, club.meetingId));
			});
			const completing = applyCompleteMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			}).catch((e: unknown) => e);
			await waitForLockWait('"meetings"', cancel.pid);
			await cancel.commit();
			const result = await completing;
			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).toBe(MEETING_CANCELLED_MESSAGE);
			expect(await meetingStatus(club.meetingId)).toBe("cancelled");
		});

		it("a Reopen racing a cancel waits on the meeting lock, then refuses the cancelled row", async () => {
			// A completed meeting that another officer reopens and cancels while
			// this Reopen is in flight. Unlocked, this Reopen reads `completed`,
			// passes its check, parks its UPDATE behind the row and then writes
			// `scheduled` over the cancel — restore's day rule bypassed again.
			await setScheduledAt(club.meetingId, new Date(Date.now() - DAY));
			await setStatus(club.meetingId, "completed");
			const cancel = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from meetings where id = ${club.meetingId} for no key update`,
				);
				await tx
					.update(meetings)
					.set({ status: "cancelled" })
					.where(eq(meetings.id, club.meetingId));
			});
			const reopening = applyReopenMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			}).catch((e: unknown) => e);
			await waitForLockWait('"meetings"', cancel.pid);
			await cancel.commit();
			const result = await reopening;
			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).toBe(
				MEETING_REOPEN_NOT_COMPLETED_MESSAGE,
			);
			expect(await meetingStatus(club.meetingId)).toBe("cancelled");
		});

		it("the control: complete then reopen still work on their normal states", async () => {
			await setScheduledAt(club.meetingId, new Date(Date.now() - DAY));
			await applyCompleteMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			expect(await meetingStatus(club.meetingId)).toBe("completed");
			await applyReopenMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			expect(await meetingStatus(club.meetingId)).toBe("scheduled");
			expect(
				(await meetingEdits(club.clubId, club.meetingId)).map((e) => e.change),
			).toEqual(["completed", "reopened"]);
		});
	});

	// Review of #1084, finding E: `joinBallotAsGuest` is public and mints a
	// `guests` row carrying a visitor's name. Cancelling does not close vote
	// sessions (a restore must lose nothing), so the join stayed open.
	describe("joining the ballot as a guest on a cancelled meeting", () => {
		async function guestsNamed(name: string) {
			return testDb
				.select({ id: guests.id })
				.from(guests)
				.where(and(eq(guests.clubId, club.clubId), eq(guests.name, name)));
		}

		it("is refused, and no guest row is minted, even with a vote open", async () => {
			await testDb
				.insert(meetingVoteSessions)
				.values({ meetingId: club.meetingId, category: "best_speaker" });
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});
			await expect(
				joinBallotAsGuest({ meetingId: club.meetingId, name: "Walk-in Wendy" }),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			expect(await guestsNamed("Walk-in Wendy")).toEqual([]);
		});

		it("the control: on the scheduled meeting the same join mints the guest", async () => {
			const joined = await joinBallotAsGuest({
				meetingId: club.meetingId,
				name: "Walk-in Wendy",
			});
			expect(await guestsNamed("Walk-in Wendy")).toEqual([{ id: joined.id }]);
		});
	});

	// Review of #1084, finding B: deactivating or removing a member released
	// their upcoming slots EXCEPT on a cancelled meeting, so a restore handed
	// the role back to someone inactive — or, after a removal, put a slot
	// `claimed` by nobody (the FK nulls the holder) on the live agenda.
	describe("a member leaving while a meeting is cancelled", () => {
		/** A roster member with no sign-in account, so removal is allowed. */
		async function seedNoAccountMember(name: string): Promise<string> {
			const [person] = await testDb
				.insert(people)
				.values({ name })
				.returning({ id: people.id });
			if (!person) throw new Error("fixture insert failed");
			const [member] = await testDb
				.insert(members)
				.values({
					clubId: club.clubId,
					personId: person.id,
					name,
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			if (!member) throw new Error("fixture insert failed");
			return member.id;
		}

		async function holdSeededSlot(memberId: string) {
			await testDb
				.update(roleSlots)
				.set({
					status: "claimed",
					assignedMemberId: memberId,
					claimedAt: new Date(),
				})
				.where(eq(roleSlots.id, club.slotId));
		}

		/** After a restore, the freed slot takes a new holder. */
		async function expectClaimableAfterRestore() {
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
		}

		it("deactivation frees the slot on a cancelled future meeting, and a restore finds it open", async () => {
			const leaver = await seedNoAccountMember("Leaving Lee");
			await holdSeededSlot(leaver);
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});

			await applySetMemberStatus({
				clubId: club.clubId,
				memberId: leaver,
				status: "inactive",
				actorMemberId: club.adminMemberId,
			});

			const [slot] = await slotRows(club.meetingId);
			expect(slot?.status).toBe("open");
			expect(slot?.assignedMemberId).toBeNull();
			await expectClaimableAfterRestore();
		});

		it("removal frees the slot on a cancelled future meeting, never leaving it claimed by nobody", async () => {
			const leaver = await seedNoAccountMember("Removed Ray");
			await holdSeededSlot(leaver);
			await applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			});

			await applyMemberRemove({
				clubId: club.clubId,
				memberId: leaver,
				actorMemberId: club.adminMemberId,
			});

			// `open`, not `claimed` with a null holder — the shape the FK would
			// leave if the release skipped this slot, which nothing can claim.
			const [slot] = await slotRows(club.meetingId);
			expect(slot?.status).toBe("open");
			expect(slot?.assignedMemberId).toBeNull();
			await expectClaimableAfterRestore();
		});
	});

	// Review of #1084, finding H: the cases the review found missing.
	describe("the cases the review found missing", () => {
		it("restore answers PAST before NOT CANCELLED: a scheduled meeting whose date has passed", async () => {
			await setScheduledAt(club.meetingId, new Date(Date.now() - 3 * DAY));
			await expect(
				applyRestoreMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(MEETING_RESTORE_PAST_MESSAGE);
		});

		it("a second club's cancelled meeting is absent from this club's list", async () => {
			const other = await seedClub();
			try {
				await applyCancelMeeting({
					meetingId: other.meetingId,
					actorMemberId: other.adminMemberId,
				});
				await applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				});
				expect(
					(await loadCancelledMeetings(club.clubId)).map((r) => r.id),
				).toEqual([club.meetingId]);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		describe("the claim statement's meeting predicate reads the slot's OWN meeting", () => {
			let siblingSlotId: string;

			beforeEach(async () => {
				// A scheduled sibling in the same club, with its own open slot. With
				// it present, a predicate that has lost its correlation (any
				// non-cancelled meeting satisfies it) admits a claim on the cancelled
				// meeting, and one widened to the club (no cancelled meeting in it)
				// refuses the sibling's.
				const [sibling] = await testDb
					.insert(meetings)
					.values({
						clubId: club.clubId,
						scheduledAt: new Date(Date.now() + 14 * DAY),
						status: "scheduled",
					})
					.returning({ id: meetings.id });
				if (!sibling) throw new Error("fixture insert failed");
				const [slot] = await testDb
					.insert(roleSlots)
					.values({
						meetingId: sibling.id,
						roleDefinitionId: club.roleDefinitionId,
						status: "open",
					})
					.returning({ id: roleSlots.id });
				if (!slot) throw new Error("fixture insert failed");
				siblingSlotId = slot.id;
				await applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				});
			});

			/** On someone's BEHALF, so the plan seam (which refuses a cancelled
			 *  meeting with the same sentence) is never reached and the claim
			 *  statement's own predicate is the only thing deciding. */
			function claimOnBehalf(slotId: string) {
				return testDb.transaction((tx) =>
					claimSlotCore(tx, {
						slotId,
						memberId: club.memberId,
						actorMemberId: club.adminMemberId,
						proof: "session",
					}),
				);
			}

			it("refuses the cancelled meeting's slot with a scheduled sibling beside it", async () => {
				await expect(claimOnBehalf(club.slotId)).rejects.toThrow(
					MEETING_CANCELLED_MESSAGE,
				);
			});

			it("admits the sibling's slot with a cancelled meeting beside it", async () => {
				await claimOnBehalf(siblingSlotId);
				const [row] = await testDb
					.select({ assignedMemberId: roleSlots.assignedMemberId })
					.from(roleSlots)
					.where(eq(roleSlots.id, siblingSlotId));
				expect(row?.assignedMemberId).toBe(club.memberId);
			});
		});

		it("two concurrent cancels: one fulfils, one is refused, one activity row", async () => {
			const results = await Promise.allSettled([
				applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
				applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			]);
			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			const refused = results.filter(
				(r): r is PromiseRejectedResult => r.status === "rejected",
			);
			expect(refused).toHaveLength(1);
			expect((refused[0]?.reason as Error).message).toBe(
				MEETING_ALREADY_CANCELLED_MESSAGE,
			);
			expect(await meetingEdits(club.clubId, club.meetingId)).toHaveLength(1);
		});

		it("a cancel racing a cancel waits on the meeting lock, then refuses the cancelled row", async () => {
			// The concurrent pair above usually interleaves the way the lock
			// forces, so it cannot tell a lock from luck. This holds the first
			// cancel open with its status written: unlocked, the second reads
			// `scheduled` and succeeds too, logging a second cancel.
			const first = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from meetings where id = ${club.meetingId} for no key update`,
				);
				await tx
					.update(meetings)
					.set({ status: "cancelled" })
					.where(eq(meetings.id, club.meetingId));
			});
			const second = applyCancelMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			}).catch((e: unknown) => e);
			await waitForLockWait('"meetings"', first.pid);
			await first.commit();
			const result = await second;
			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).toBe(MEETING_ALREADY_CANCELLED_MESSAGE);
			expect(await meetingEdits(club.clubId, club.meetingId)).toEqual([]);
		});

		describe("the boundaries (America/Chicago), under a faked clock: cancel's start instant, restore's and the list's club-local day", () => {
			// Only `Date` is faked: the pg pool's own timers must keep running.
			afterEach(() => {
				vi.useRealTimers();
			});

			function at(iso: string) {
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(iso));
			}

			it("cancel refuses a meeting from YESTERDAY evening locally, though it is TODAY in UTC", async () => {
				// 01:00Z on 3 Oct is 20:00 CDT on 2 Oct: yesterday for the club.
				await setScheduledAt(club.meetingId, new Date("2026-10-03T01:00:00Z"));
				at("2026-10-03T15:00:00Z");
				await expect(
					applyCancelMeeting({
						meetingId: club.meetingId,
						actorMemberId: club.adminMemberId,
					}),
				).rejects.toThrow(MEETING_CANCEL_PAST_MESSAGE);
			});

			// Cancel's boundary is the START instant (maintainer, #1084), so the
			// next three pin that instant and the cases either side of a day line.
			it("cancel refuses a meeting that STARTED earlier today locally, though the day is not over", async () => {
				// 23:00Z on 2 Oct is 18:00 CDT on 2 Oct; the clock reads 23:30 CDT,
				// the same club-local day — which the old day rule would admit.
				await setScheduledAt(club.meetingId, new Date("2026-10-02T23:00:00Z"));
				at("2026-10-03T04:30:00Z");
				await expect(
					applyCancelMeeting({
						meetingId: club.meetingId,
						actorMemberId: club.adminMemberId,
					}),
				).rejects.toThrow(MEETING_CANCEL_PAST_MESSAGE);
			});

			it("cancel admits a meeting LATER today locally that is TOMORROW in UTC", async () => {
				// 01:00Z on 4 Oct is 20:00 CDT on 3 Oct; the clock reads 10:00 CDT.
				await setScheduledAt(club.meetingId, new Date("2026-10-04T01:00:00Z"));
				at("2026-10-03T15:00:00Z");
				await applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				});
				expect(await meetingStatus(club.meetingId)).toBe("cancelled");
			});

			it("cancel refuses at the start instant itself, and admits one millisecond before it", async () => {
				const start = new Date("2026-10-03T23:00:00Z");
				await setScheduledAt(club.meetingId, start);
				at("2026-10-03T23:00:00.000Z");
				await expect(
					applyCancelMeeting({
						meetingId: club.meetingId,
						actorMemberId: club.adminMemberId,
					}),
				).rejects.toThrow(MEETING_CANCEL_PAST_MESSAGE);
				vi.setSystemTime(new Date(start.getTime() - 1));
				await applyCancelMeeting({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				});
				expect(await meetingStatus(club.meetingId)).toBe("cancelled");
			});

			it("restore refuses a meeting from yesterday evening locally, though it is today in UTC", async () => {
				await setScheduledAt(club.meetingId, new Date("2026-10-03T01:00:00Z"));
				await setStatus(club.meetingId, "cancelled");
				at("2026-10-03T15:00:00Z");
				await expect(
					applyRestoreMeeting({
						meetingId: club.meetingId,
						actorMemberId: club.adminMemberId,
					}),
				).rejects.toThrow(MEETING_RESTORE_PAST_MESSAGE);
			});

			it("the cancelled list's floor is the start of the CLUB's day, not UTC's", async () => {
				// The clock reads 23:30 CDT on 2 Oct (04:30Z on 3 Oct). A meeting
				// at 18:00 CDT today is listed; one at 23:00 CDT yesterday is not.
				// A UTC floor (00:00Z on 3 Oct) would drop today's as well.
				await setScheduledAt(club.meetingId, new Date("2026-10-02T23:00:00Z"));
				await setStatus(club.meetingId, "cancelled");
				const [yesterday] = await testDb
					.insert(meetings)
					.values({
						clubId: club.clubId,
						scheduledAt: new Date("2026-10-02T04:00:00Z"),
						status: "cancelled",
					})
					.returning({ id: meetings.id });
				if (!yesterday) throw new Error("fixture insert failed");
				at("2026-10-03T04:30:00Z");
				expect(
					(await loadCancelledMeetings(club.clubId)).map((r) => r.id),
				).toEqual([club.meetingId]);
			});
		});
	});
});

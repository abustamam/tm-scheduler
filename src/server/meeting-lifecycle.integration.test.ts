/**
 * DB-backed tests for the meeting lifecycle + lock (issue #150). A meeting moves
 * `scheduled → completed` (admin "Complete", date-guarded) and back
 * `completed → scheduled` (admin "Reopen"). A completed meeting is LOCKED: every
 * agenda mutation is rejected server-side. These tests prove the server-side
 * rejection at the logic/guard layer the server fns delegate to (server fns
 * themselves can't be invoked directly — createServerFn — so we exercise the
 * plain logic with `#/db` pointed at the test database, matching the repo's
 * integration-test convention).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-lifecycle.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings } from "#/db/schema";
import {
	MEETING_LOCKED_MESSAGE,
	meetingDateReached,
} from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { assertMeetingNotLocked, resolveMeetingAgendaAuthz } = await import(
	"./meeting-authz-logic"
);
const { applyCompleteMeeting, applyReopenMeeting } = await import(
	"./meetings-logic"
);
const { applyAddRoleSlot, applyRemoveRoleSlot, reassignSlotCore } =
	await import("./slots-logic");

/** Push the seeded meeting's date into the past so it can be completed. */
async function makePast(meetingId: string): Promise<void> {
	await testDb
		.update(meetings)
		.set({ scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
		.where(eq(meetings.id, meetingId));
}

/** Force the meeting into the locked (completed) state directly. */
async function markCompleted(meetingId: string): Promise<void> {
	await testDb
		.update(meetings)
		.set({ status: "completed" })
		.where(eq(meetings.id, meetingId));
}

// --- Pure helpers (no DB) --------------------------------------------------

describe("assertMeetingNotLocked", () => {
	it("throws the lock message for a completed meeting", () => {
		expect(() => assertMeetingNotLocked("completed")).toThrow(
			MEETING_LOCKED_MESSAGE,
		);
	});
	it("allows a scheduled meeting", () => {
		expect(() => assertMeetingNotLocked("scheduled")).not.toThrow();
	});
});

describe("meetingDateReached", () => {
	const tz = "America/Chicago";
	it("is false for a future meeting", () => {
		const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		expect(meetingDateReached(future, tz)).toBe(false);
	});
	it("is true for a past meeting", () => {
		const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		expect(meetingDateReached(past, tz)).toBe(true);
	});
	it("is true for a meeting earlier today (same calendar date)", () => {
		const now = new Date();
		expect(meetingDateReached(now, tz, now)).toBe(true);
	});
});

// --- DB-backed lifecycle + lock -------------------------------------------

describe.skipIf(!hasTestDb)("meeting lifecycle + lock (#150)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("rejects completing a future meeting (date guard)", async () => {
		// seedClub schedules the meeting 7 days out.
		await expect(
			applyCompleteMeeting({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/scheduled date/i);
	});

	it("completes a meeting whose date has passed, then reopens it", async () => {
		await makePast(club.meetingId);

		await applyCompleteMeeting({
			meetingId: club.meetingId,
			actorMemberId: club.adminMemberId,
		});
		let row = await testDb.query.meetings.findFirst({
			where: (m, { eq: e }) => e(m.id, club.meetingId),
		});
		expect(row?.status).toBe("completed");

		// Reopen has no date guard and returns it to scheduled.
		await applyReopenMeeting({
			meetingId: club.meetingId,
			actorMemberId: club.adminMemberId,
		});
		row = await testDb.query.meetings.findFirst({
			where: (m, { eq: e }) => e(m.id, club.meetingId),
		});
		expect(row?.status).toBe("scheduled");
	});

	it("locks the agenda-editor path — even for an admin — when completed", async () => {
		await markCompleted(club.meetingId);
		await expect(
			resolveMeetingAgendaAuthz({
				meetingId: club.meetingId,
				sessionUserId: club.adminUserId,
			}),
		).rejects.toThrow(MEETING_LOCKED_MESSAGE);
	});

	it("still authorizes the agenda-editor path when scheduled (control)", async () => {
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.adminUserId,
		});
		expect(authz.allowed).toBe(true);
	});

	it("rejects reassign (claim/takeover path) when completed", async () => {
		await markCompleted(club.meetingId);
		await expect(
			testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId: club.slotId,
					memberId: club.memberId,
					actorMemberId: club.memberId,
				}),
			),
		).rejects.toThrow(MEETING_LOCKED_MESSAGE);
	});

	it("rejects adding a role slot when completed", async () => {
		await markCompleted(club.meetingId);
		await expect(
			applyAddRoleSlot({
				meetingId: club.meetingId,
				roleDefinitionId: club.roleDefinitionId,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(MEETING_LOCKED_MESSAGE);
	});

	it("rejects removing a role slot when completed", async () => {
		await markCompleted(club.meetingId);
		await expect(
			applyRemoveRoleSlot({
				slotId: club.slotId,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(MEETING_LOCKED_MESSAGE);
	});

	it("allows editing again after reopen", async () => {
		await markCompleted(club.meetingId);
		await applyReopenMeeting({
			meetingId: club.meetingId,
			actorMemberId: club.adminMemberId,
		});
		// The add-role path succeeds once the meeting is unlocked again.
		await expect(
			applyAddRoleSlot({
				meetingId: club.meetingId,
				roleDefinitionId: club.roleDefinitionId,
				actorMemberId: club.adminMemberId,
			}),
		).resolves.toBeTruthy();
	});
});

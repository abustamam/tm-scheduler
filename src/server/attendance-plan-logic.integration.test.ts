/**
 * DB-backed tests for the meeting_attendance_plan store.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/attendance-plan-logic.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, meetingAttendancePlan } from "#/db/schema";
import {
	clearPlanStatus,
	getPlanStatus,
	listNotComingForMeetings,
	setPlanStatus,
} from "#/server/attendance-plan-logic";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

describe.skipIf(!hasTestDb)("meeting_attendance_plan table", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("stores each of the three statuses", async () => {
		for (const status of ["reached_out", "coming", "not_coming"] as const) {
			await testDb
				.insert(meetingAttendancePlan)
				.values({
					memberId: club.memberId,
					meetingId: club.meetingId,
					status,
				})
				.onConflictDoUpdate({
					target: [
						meetingAttendancePlan.memberId,
						meetingAttendancePlan.meetingId,
					],
					set: { status },
				});
			const [row] = await testDb
				.select({ status: meetingAttendancePlan.status })
				.from(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.memberId, club.memberId),
						eq(meetingAttendancePlan.meetingId, club.meetingId),
					),
				);
			expect(row?.status).toBe(status);
		}
	});

	it("allows at most one row per (member, meeting)", async () => {
		await testDb.insert(meetingAttendancePlan).values({
			memberId: club.memberId,
			meetingId: club.meetingId,
			status: "coming",
		});
		// Assert the Postgres unique-violation specifically (SQLSTATE 23505), not
		// merely "threw something" — a renamed column or an unrelated constraint
		// would also satisfy a bare `.rejects.toThrow()`. Drizzle wraps the raw pg
		// error in a `DrizzleQueryError` whose own `.message` is just
		// "Failed query: insert into ..."; the SQLSTATE and the
		// "duplicate key value violates unique constraint" text live on `.cause`,
		// the underlying `pg` error — verified against the real error shape here,
		// not guessed.
		await expect(
			testDb.insert(meetingAttendancePlan).values({
				memberId: club.memberId,
				meetingId: club.meetingId,
				status: "not_coming",
			}),
		).rejects.toMatchObject({
			cause: { code: "23505" },
		});
	});
});

describe.skipIf(!hasTestDb)("attendance-plan seam", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("upserts rather than duplicating on a second write", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "reached_out",
			actorMemberId: club.adminMemberId,
		});
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		const rows = await testDb
			.select()
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.memberId, club.memberId));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("coming");
	});

	it("clearing removes the row entirely, not sets a status", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		await clearPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		const rows = await testDb
			.select()
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.memberId, club.memberId));
		expect(rows).toHaveLength(0);
	});

	it("logs plan_set with the status in the detail, attributed to the acting officer", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
			via: "manual",
		});
		const [entry] = await testDb
			.select({
				action: activityLog.action,
				actorMemberId: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.action).toBe("plan_set");
		// Actor = the officer who acted; subject (detail.memberId) = the member
		// whose plan changed. These must NOT collapse to the same thing — a
		// regression that hardcoded or dropped actorMemberId would still pass an
		// assertion that only looks at detail.
		expect(entry?.actorMemberId).toBe(club.adminMemberId);
		expect(entry?.detail).toMatchObject({
			memberId: club.memberId,
			status: "coming",
			via: "manual",
		});
	});

	it("logs a clear as plan_set with a null status, attributed to the acting officer", async () => {
		await clearPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		const [entry] = await testDb
			.select({
				action: activityLog.action,
				actorMemberId: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.action).toBe("plan_set");
		expect(entry?.actorMemberId).toBe(club.adminMemberId);
		expect(entry?.detail).toMatchObject({ status: null });
	});

	it("logs a null actor as null, not the subject — the impersonation path", async () => {
		// actorMemberId: null is a decision, not an omission (see setPlanStatus's
		// jsdoc): it's what an impersonated write resolves to before `logActivity`
		// stamps the real superadmin via the request-scoped marker. Outside a
		// request context (as in this test) that marker is unset, so the row
		// should land with actor_member_id NULL rather than silently falling back
		// to the subject member.
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "not_coming",
			actorMemberId: null,
		});
		const [entry] = await testDb
			.select({
				actorMemberId: activityLog.actorMemberId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(eq(activityLog.clubId, club.clubId));
		expect(entry?.actorMemberId).toBe(null);
		expect(entry?.detail).toMatchObject({ memberId: club.memberId });
	});

	it("getPlanStatus returns null for no answer and the rung once set", async () => {
		expect(
			await getPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
			}),
		).toBe(null);
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "not_coming",
			actorMemberId: club.adminMemberId,
		});
		expect(
			await getPlanStatus(testDb, {
				memberId: club.memberId,
				meetingId: club.meetingId,
			}),
		).toBe("not_coming");
	});

	it("getPlanStatus reads its own transaction's uncommitted write", async () => {
		// It takes a DbOrTx for exactly this: `markComingOnSelfClaim` calls it
		// inside the claim's transaction, and a read through the pool client there
		// would see the world as it was before the claim.
		await testDb.transaction(async (tx) => {
			await setPlanStatus(tx, {
				memberId: club.memberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
				status: "coming",
				actorMemberId: club.memberId,
			});
			expect(
				await getPlanStatus(tx, {
					memberId: club.memberId,
					meetingId: club.meetingId,
				}),
			).toBe("coming");
		});
	});

	it("listNotComingForMeetings returns ONLY not_coming rows", async () => {
		await setPlanStatus(testDb, {
			memberId: club.memberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "coming",
			actorMemberId: club.adminMemberId,
		});
		await setPlanStatus(testDb, {
			memberId: club.adminMemberId,
			meetingId: club.meetingId,
			clubId: club.clubId,
			status: "not_coming",
			actorMemberId: club.adminMemberId,
		});
		const out = await listNotComingForMeetings(testDb, [club.meetingId]);
		expect(out).toEqual([
			{ memberId: club.adminMemberId, meetingId: club.meetingId },
		]);
	});

	it("listNotComingForMeetings skips the round-trip on an empty id list", async () => {
		const spy = vi.spyOn(testDb, "select");
		const out = await listNotComingForMeetings(testDb, []);
		expect(out).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

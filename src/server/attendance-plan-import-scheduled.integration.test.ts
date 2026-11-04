/**
 * `importPlanAnswers`' `allowScheduled` opt-in (#1495): the upcoming-meeting
 * import writes RSVPs into a SCHEDULED meeting. The default stays completed
 * only; cancelled is refused either way; a member's own answer always wins.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, meetingAttendancePlan, meetings } from "#/db/schema";
import {
	IMPORT_PLAN_STATUS_MESSAGE,
	importPlanAnswers,
} from "#/server/attendance-plan-logic";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("importPlanAnswers allowScheduled (#1495)", () => {
	let club: SeededClub;
	const setStatus = (status: "scheduled" | "cancelled" | "completed") =>
		testDb
			.update(meetings)
			.set({ status })
			.where(eq(meetings.id, club.meetingId));
	const rows = () =>
		testDb
			.select({
				memberId: meetingAttendancePlan.memberId,
				status: meetingAttendancePlan.status,
			})
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.meetingId, club.meetingId));
	const answers = () => [
		{ memberId: club.memberId, status: "coming" as const },
	];

	beforeEach(async () => {
		club = await seedClub();
		await setStatus("scheduled");
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("refuses a scheduled meeting by default", async () => {
		await expect(
			importPlanAnswers(testDb, {
				meetingId: club.meetingId,
				answers: answers(),
			}),
		).rejects.toThrow(IMPORT_PLAN_STATUS_MESSAGE);
		expect(await rows()).toEqual([]);
	});

	it("accepts a scheduled meeting with the opt-in, logging nothing", async () => {
		const before = (
			await testDb
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(eq(activityLog.clubId, club.clubId))
		).length;
		const result = await importPlanAnswers(
			testDb,
			{ meetingId: club.meetingId, answers: answers() },
			{ allowScheduled: true },
		);
		expect(result).toEqual({ inserted: 1 });
		expect(await rows()).toEqual([
			{ memberId: club.memberId, status: "coming" },
		]);
		const after = (
			await testDb
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(eq(activityLog.clubId, club.clubId))
		).length;
		expect(after).toBe(before);
	});

	it("still refuses a cancelled meeting with the opt-in", async () => {
		await setStatus("cancelled");
		await expect(
			importPlanAnswers(
				testDb,
				{ meetingId: club.meetingId, answers: answers() },
				{ allowScheduled: true },
			),
		).rejects.toThrow();
		expect(await rows()).toEqual([]);
	});

	it("does not overwrite a member's own answer", async () => {
		await testDb.insert(meetingAttendancePlan).values({
			memberId: club.memberId,
			meetingId: club.meetingId,
			status: "not_coming",
		});
		const result = await importPlanAnswers(
			testDb,
			{ meetingId: club.meetingId, answers: answers() },
			{ allowScheduled: true },
		);
		expect(result).toEqual({ inserted: 0 });
		expect(await rows()).toEqual([
			{ memberId: club.memberId, status: "not_coming" },
		]);
	});
});

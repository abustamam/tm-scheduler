/**
 * DB-backed integration tests for the "contacted" write logic (#340), now the
 * `reached_out` rung of `meeting_attendance_plan` (D6, 2026-08-11).
 *
 * Same honest limitation as availability.integration.test.ts: a
 * `createServerFn` handler cannot be invoked in vitest, so the helpers below
 * reproduce what the (now delegating) handlers do. Their officer-only gating is
 * covered structurally by outreach-authz.guard.test.ts.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/outreach.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, meetingAttendancePlan } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import {
	CLEARABLE_ASK,
	clearPlanStatus,
	setPlanStatus,
} from "./attendance-plan-logic";

async function setContactedDb(args: {
	memberId: string;
	meetingId: string;
	clubId: string;
	actorMemberId: string;
	via: "nudge" | "manual";
}) {
	await setPlanStatus(testDb, {
		memberId: args.memberId,
		meetingId: args.meetingId,
		clubId: args.clubId,
		status: "reached_out",
		actorMemberId: args.actorMemberId,
		via: args.via,
	});
	return { ok: true as const };
}

async function clearContactedDb(args: {
	memberId: string;
	meetingId: string;
	clubId: string;
	actorMemberId: string;
}) {
	await clearPlanStatus(testDb, {
		memberId: args.memberId,
		meetingId: args.meetingId,
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		// What `outreach.ts` passes inline — it has always been narrow by
		// construction, which is the shape #573 restored on the panel's clear.
		onlyFrom: CLEARABLE_ASK,
	});
	return { ok: true as const };
}

async function planRows(memberId: string, meetingId: string) {
	return testDb
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, memberId),
				eq(meetingAttendancePlan.meetingId, meetingId),
			),
		);
}

describe.skipIf(!hasTestDb)("meeting outreach (set + clear)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("setContacted records reached_out and logs plan_set attributed to the officer with the subject + via in detail", async () => {
		await setContactedDb({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
			via: "nudge",
		});
		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		// The rung, not merely a row: a `not_coming` row would satisfy an
		// existence assertion while meaning something else entirely.
		expect(rows[0]?.status).toBe("reached_out");
		const [log] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "plan_set"),
				),
			)
			.limit(1);
		expect(log?.actorMemberId).toBe(seed.adminMemberId);
		expect(log?.detail).toMatchObject({
			memberId: seed.memberId,
			status: "reached_out",
			via: "nudge",
		});
	});

	it("setContacted is idempotent (the seam upserts → one row)", async () => {
		const args = {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
			via: "manual" as const,
		};
		await setContactedDb(args);
		await expect(setContactedDb(args)).resolves.toEqual({ ok: true });
		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("reached_out");
	});

	it("clearContacted removes the row and logs plan_set with a null rung", async () => {
		await setContactedDb({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
			via: "manual",
		});
		await clearContactedDb({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
		});
		expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
		const log = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "plan_set"),
				),
			);
		expect(
			log.filter(
				(l) => (l.detail as { status?: unknown } | null)?.status === null,
			),
		).toHaveLength(1);
	});

	it("clearContacted on a non-existent row is a no-op (no throw)", async () => {
		await expect(
			clearContactedDb({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				actorMemberId: seed.adminMemberId,
			}),
		).resolves.toEqual({ ok: true });
	});
});

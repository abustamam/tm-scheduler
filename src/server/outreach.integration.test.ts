/**
 * DB-backed integration tests for the meeting_outreach write logic (#340).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/outreach.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, meetingOutreach } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

async function setContactedDb(args: {
	memberId: string;
	meetingId: string;
	clubId: string;
	actorMemberId: string;
	via: "nudge" | "manual";
}) {
	await testDb
		.insert(meetingOutreach)
		.values({ memberId: args.memberId, meetingId: args.meetingId })
		.onConflictDoNothing();
	await testDb.insert(activityLog).values({
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "outreach_set",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: { memberId: args.memberId, via: args.via },
	});
	return { ok: true as const };
}

async function clearContactedDb(args: {
	memberId: string;
	meetingId: string;
	clubId: string;
	actorMemberId: string;
}) {
	await testDb
		.delete(meetingOutreach)
		.where(
			and(
				eq(meetingOutreach.memberId, args.memberId),
				eq(meetingOutreach.meetingId, args.meetingId),
			),
		);
	await testDb.insert(activityLog).values({
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "outreach_clear",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: { memberId: args.memberId },
	});
	return { ok: true as const };
}

describe.skipIf(!hasTestDb)("meeting outreach (set + clear)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("setContacted inserts a row and logs outreach_set attributed to the officer with the subject + via in detail", async () => {
		await setContactedDb({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
			via: "nudge",
		});
		const rows = await testDb
			.select()
			.from(meetingOutreach)
			.where(
				and(
					eq(meetingOutreach.memberId, seed.memberId),
					eq(meetingOutreach.meetingId, seed.meetingId),
				),
			);
		expect(rows).toHaveLength(1);
		const [log] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "outreach_set"),
				),
			)
			.limit(1);
		expect(log?.actorMemberId).toBe(seed.adminMemberId);
		expect((log?.detail as { memberId?: string })?.memberId).toBe(
			seed.memberId,
		);
		expect((log?.detail as { via?: string })?.via).toBe("nudge");
	});

	it("setContacted is idempotent (onConflictDoNothing → one row)", async () => {
		const args = {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
			via: "manual" as const,
		};
		await setContactedDb(args);
		await expect(setContactedDb(args)).resolves.toEqual({ ok: true });
		const rows = await testDb
			.select()
			.from(meetingOutreach)
			.where(
				and(
					eq(meetingOutreach.memberId, seed.memberId),
					eq(meetingOutreach.meetingId, seed.meetingId),
				),
			);
		expect(rows).toHaveLength(1);
	});

	it("clearContacted removes the row and logs outreach_clear", async () => {
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
		const rows = await testDb
			.select()
			.from(meetingOutreach)
			.where(
				and(
					eq(meetingOutreach.memberId, seed.memberId),
					eq(meetingOutreach.meetingId, seed.meetingId),
				),
			);
		expect(rows).toHaveLength(0);
		const log = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "outreach_clear"),
				),
			);
		expect(log.length).toBeGreaterThan(0);
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

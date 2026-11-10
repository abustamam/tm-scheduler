/**
 * DB-backed tests for `complete_meeting` and `reopen_meeting` (#1572), shaped
 * like `cancel-restore-meeting.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	meetings,
	meetingVoteSessions,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");

const { completeMeetingTool } = await import(
	"#/server/mcp/tools/complete-meeting"
);
const { reopenMeetingTool } = await import("#/server/mcp/tools/reopen-meeting");
const { cancelMeetingTool } = await import("#/server/mcp/tools/cancel-meeting");

async function mintToken(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw) });
	return raw;
}

async function expectMcpError(
	p: Promise<unknown>,
	code: string,
	message?: string,
) {
	const err = await p.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(McpError);
	expect((err as InstanceType<typeof McpError>).code).toBe(code);
	if (message !== undefined) {
		expect((err as InstanceType<typeof McpError>).message).toBe(message);
	}
}

describe.skipIf(!hasTestDb)("complete_meeting / reopen_meeting (#1572)", () => {
	let seed: SeededClub;
	let adminToken: string;
	let memberToken: string;

	const complete = (t: string) =>
		completeMeetingTool.handler({ meetingId: seed.meetingId }, { rawToken: t });
	const reopen = (t: string) =>
		reopenMeetingTool.handler({ meetingId: seed.meetingId }, { rawToken: t });
	const status = async () =>
		(
			await testDb.query.meetings.findFirst({
				where: eq(meetings.id, seed.meetingId),
				columns: { status: true },
			})
		)?.status;
	const setDate = (d: Date) =>
		testDb
			.update(meetings)
			.set({ scheduledAt: d })
			.where(eq(meetings.id, seed.meetingId));
	const past = () => new Date(Date.now() - 3 * 86_400_000);

	beforeEach(async () => {
		seed = await seedClub();
		adminToken = await mintToken(seed.adminUserId);
		memberToken = await mintToken(seed.memberUserId);
	});
	afterEach(async () => {
		await testDb
			.delete(apiTokens)
			.where(inArray(apiTokens.userId, [seed.adminUserId, seed.memberUserId]));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("completes a past meeting, closes open ballots and reports the count", async () => {
		await setDate(past());
		await testDb
			.insert(meetingVoteSessions)
			.values({ meetingId: seed.meetingId, category: "best_speaker" });
		const r = await complete(adminToken);
		expect(r).toEqual({
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "completed",
			closedVotes: 1,
		});
		expect(await status()).toBe("completed");
		const [v] = await testDb
			.select()
			.from(meetingVoteSessions)
			.where(eq(meetingVoteSessions.meetingId, seed.meetingId));
		expect(v?.closedAt).not.toBeNull();
		const logs = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "meeting_edit"),
				),
			);
		expect(logs.map((l) => (l.detail as { change: string }).change)).toContain(
			"completed",
		);
	});

	it("refuses a meeting before its date, a cancelled one and a completed one", async () => {
		await expectMcpError(complete(adminToken), "VALIDATION");
		expect(await status()).toBe("scheduled");
		await setDate(new Date(Date.now() + 86_400_000));
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(complete(adminToken), "VALIDATION");
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(complete(adminToken), "LOCKED");
	});

	it("reopen returns a completed meeting to scheduled and refuses scheduled or cancelled", async () => {
		await expectMcpError(reopen(adminToken), "VALIDATION");
		await setDate(past());
		await complete(adminToken);
		expect(await reopen(adminToken)).toEqual({
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "scheduled",
		});
		expect(await status()).toBe("scheduled");
		await setDate(new Date(Date.now() + 86_400_000));
		await cancelMeetingTool.handler(
			{ meetingId: seed.meetingId },
			{ rawToken: adminToken },
		);
		await expectMcpError(reopen(adminToken), "VALIDATION");
		expect(await status()).toBe("cancelled");
	});

	it("a plain member is refused by both, and an archived club returns ARCHIVED", async () => {
		await setDate(past());
		await expectMcpError(complete(memberToken), "FORBIDDEN");
		await expectMcpError(reopen(memberToken), "FORBIDDEN");
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await expectMcpError(
			complete(adminToken),
			"ARCHIVED",
			CLUB_ARCHIVED_MESSAGE,
		);
		await expectMcpError(reopen(adminToken), "ARCHIVED", CLUB_ARCHIVED_MESSAGE);
	});
});

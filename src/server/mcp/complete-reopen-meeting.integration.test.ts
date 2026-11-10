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
	MEETING_CANCELLED_MESSAGE,
	MEETING_REOPEN_NOT_COMPLETED_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Runs once just before the real seam, to move state after the tool's own
// early checks have passed.
const beforeSeam = vi.hoisted(() => ({
	run: null as null | (() => Promise<void>),
}));
vi.mock("#/server/meetings-logic", async (importOriginal) => {
	const orig = await importOriginal<typeof import("#/server/meetings-logic")>();
	return {
		...orig,
		applyCompleteMeeting: async (
			...args: Parameters<typeof orig.applyCompleteMeeting>
		) => {
			const hook = beforeSeam.run;
			beforeSeam.run = null;
			if (hook) await hook();
			return orig.applyCompleteMeeting(...args);
		},
	};
});

const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");

const { completeMeetingTool, NOT_YET_MESSAGE, ALREADY_COMPLETED_MESSAGE } =
	await import("#/server/mcp/tools/complete-meeting");
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
		beforeSeam.run = null;
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

	it("refuses a meeting before its date, a cancelled one and a completed one, each with its own sentence", async () => {
		await expectMcpError(complete(adminToken), "VALIDATION", NOT_YET_MESSAGE);
		expect(await status()).toBe("scheduled");
		// PAST date, so the cancelled case cannot pass through the not-yet branch.
		await setDate(past());
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(
			complete(adminToken),
			"VALIDATION",
			MEETING_CANCELLED_MESSAGE,
		);
		expect(await status()).toBe("cancelled");
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(
			complete(adminToken),
			"LOCKED",
			ALREADY_COMPLETED_MESSAGE,
		);
	});

	it("two concurrent completes: exactly one wins, the other is LOCKED, one log row", async () => {
		await setDate(past());
		const results = await Promise.allSettled([
			complete(adminToken),
			complete(adminToken),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const lost = results.find((r) => r.status === "rejected") as
			| PromiseRejectedResult
			| undefined;
		expect(lost?.reason).toBeInstanceOf(McpError);
		expect((lost?.reason as InstanceType<typeof McpError>).code).toBe("LOCKED");
		const logs = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "meeting_edit"),
				),
			);
		expect(logs).toHaveLength(1);
	});

	it("a meeting completed or cancelled after the tool's early checks is refused by the seam, mapped to LOCKED / VALIDATION, and nothing is written", async () => {
		await setDate(past());
		beforeSeam.run = async () => {
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, seed.meetingId));
		};
		await expectMcpError(
			complete(adminToken),
			"LOCKED",
			ALREADY_COMPLETED_MESSAGE,
		);
		const logsOf = () =>
			testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.targetId, seed.meetingId),
						eq(activityLog.action, "meeting_edit"),
					),
				);
		expect(await logsOf()).toHaveLength(0);

		await testDb
			.update(meetings)
			.set({ status: "scheduled" })
			.where(eq(meetings.id, seed.meetingId));
		beforeSeam.run = async () => {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seed.meetingId));
		};
		await expectMcpError(
			complete(adminToken),
			"VALIDATION",
			MEETING_CANCELLED_MESSAGE,
		);
		expect(await status()).toBe("cancelled");
	});

	it("the seam's own refusal is mapped: a meeting rescheduled into the future after the tool's check is VALIDATION, not a 500", async () => {
		await setDate(past());
		// Between the tool's early read and the seam's locked read the date moves.
		beforeSeam.run = async () => {
			await setDate(new Date(Date.now() + 3 * 86_400_000));
		};
		await expectMcpError(complete(adminToken), "VALIDATION", NOT_YET_MESSAGE);
		expect(await status()).toBe("scheduled");
	});

	it("reopen returns a completed meeting to scheduled and refuses scheduled or cancelled", async () => {
		await expectMcpError(
			reopen(adminToken),
			"VALIDATION",
			MEETING_REOPEN_NOT_COMPLETED_MESSAGE,
		);
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
		await expectMcpError(
			reopen(adminToken),
			"VALIDATION",
			MEETING_REOPEN_NOT_COMPLETED_MESSAGE,
		);
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

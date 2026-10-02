/**
 * DB-backed tests for `cancel_meeting` and `restore_meeting` (#1057).
 *
 * The tools authorize through `authorizeTokenForMeeting` — an admin or an
 * officer of the meeting's club, nobody else, and never an archived club — and
 * then call the same seams the browser's server fns call. So this suite is
 * where the ROLE gate is exercised end to end: `meeting-cancel.integration.test.ts`
 * drives the seams directly and cannot see who may call them.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/cancel-restore-meeting.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	meetings,
	members,
	officerTerms,
	people,
	roleSlots,
	user,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	MEETING_ALREADY_CANCELLED_MESSAGE,
	MEETING_CANCEL_COMPLETED_MESSAGE,
	MEETING_NOT_CANCELLED_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { cancelMeetingTool } = await import("#/server/mcp/tools/cancel-meeting");
const { restoreMeetingTool } = await import(
	"#/server/mcp/tools/restore-meeting"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");

interface Cancelled {
	meetingId: string;
	clubId: string;
	status: "cancelled";
	notice: string;
}
interface Restored {
	meetingId: string;
	clubId: string;
	status: "scheduled";
}

describe.skipIf(!hasTestDb)("cancel_meeting / restore_meeting (#1057)", () => {
	let seed: SeededClub;
	let adminToken: string;
	let memberToken: string;
	let officerToken: string;
	let officerUserId: string;
	let officerMemberId: string;

	/** Mint a token for a user, the way the transport resolves one. */
	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	function cancel(token: string, meetingId = seed.meetingId) {
		return cancelMeetingTool.handler({ meetingId }, { rawToken: token });
	}
	function restore(token: string, meetingId = seed.meetingId) {
		return restoreMeetingTool.handler({ meetingId }, { rawToken: token });
	}

	async function status() {
		const row = await testDb.query.meetings.findFirst({
			where: eq(meetings.id, seed.meetingId),
			columns: { status: true },
		});
		return row?.status;
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

	beforeEach(async () => {
		seed = await seedClub();
		adminToken = await mintToken(seed.adminUserId);
		memberToken = await mintToken(seed.memberUserId);

		// A plain member holding an open office: an officer, not a stored admin.
		officerUserId = randomUUID();
		await testDb.insert(user).values({
			id: officerUserId,
			name: "Officer User",
			email: `officer-${officerUserId}@test.example`,
			emailVerified: true,
		});
		const [person] = await testDb
			.insert(people)
			.values({
				name: "Officer User",
				email: `officer-${officerUserId}@test.example`,
				userId: officerUserId,
			})
			.returning({ id: people.id });
		const [membership] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				personId: person!.id,
				name: "Officer User",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		officerMemberId = membership!.id;
		await testDb.insert(officerTerms).values({
			membershipId: officerMemberId,
			position: "vp_education",
			termStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
			termEnd: null,
		});
		officerToken = await mintToken(officerUserId);
	});

	afterEach(async () => {
		await testDb
			.delete(apiTokens)
			.where(
				inArray(apiTokens.userId, [
					seed.adminUserId,
					seed.memberUserId,
					officerUserId,
				]),
			);
		await cleanup(seed.clubId, [
			seed.adminUserId,
			seed.memberUserId,
			officerUserId,
		]);
	});

	it("an admin cancels: status cancelled, and the result carries the drafted notice", async () => {
		const result = (await cancel(adminToken)) as Cancelled;
		expect(result.status).toBe("cancelled");
		expect(result.meetingId).toBe(seed.meetingId);
		expect(result.clubId).toBe(seed.clubId);
		expect(result.notice).toMatch(/^Our meeting on .+ is cancelled\.$/);
		expect(await status()).toBe("cancelled");
	});

	it("the notice names every role holder, from the agenda's own slot loader", async () => {
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: seed.memberId })
			.where(eq(roleSlots.id, seed.slotId));
		const result = (await cancel(adminToken)) as Cancelled;
		expect(result.notice).toContain("Timer: Member User");
		// Names only: the connector never carries an address.
		expect(result.notice).not.toContain("@");
	});

	it("an admin restores: status scheduled, and no notice", async () => {
		await cancel(adminToken);
		const result = (await restore(adminToken)) as Restored;
		expect(result).toEqual({
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "scheduled",
		});
		expect("notice" in result).toBe(false);
		expect(await status()).toBe("scheduled");
	});

	it("an officer who is not a stored admin may cancel and restore", async () => {
		await cancel(officerToken);
		expect(await status()).toBe("cancelled");
		await restore(officerToken);
		expect(await status()).toBe("scheduled");
		// Credited to the officer's own membership.
		const rows = await testDb
			.select({ actorMemberId: activityLog.actorMemberId })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "meeting_edit"),
					eq(activityLog.targetId, seed.meetingId),
				),
			);
		expect(rows.map((r) => r.actorMemberId)).toEqual([
			officerMemberId,
			officerMemberId,
		]);
	});

	it("a plain member is refused by both tools, and nothing changes", async () => {
		await expectMcpError(cancel(memberToken), "FORBIDDEN");
		expect(await status()).toBe("scheduled");
		await cancel(adminToken);
		await expectMcpError(restore(memberToken), "FORBIDDEN");
		expect(await status()).toBe("cancelled");
	});

	it("an archived club refuses both tools, even for its admin", async () => {
		await cancel(adminToken);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await expectMcpError(
			restore(adminToken),
			"ARCHIVED",
			CLUB_ARCHIVED_MESSAGE,
		);
		expect(await status()).toBe("cancelled");
		await testDb
			.update(clubs)
			.set({ archivedAt: null })
			.where(eq(clubs.id, seed.clubId));
		await restore(adminToken);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await expectMcpError(cancel(adminToken), "ARCHIVED", CLUB_ARCHIVED_MESSAGE);
		expect(await status()).toBe("scheduled");
	});

	it("a completed meeting is refused as LOCKED, with the seam's own sentence", async () => {
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(
			cancel(adminToken),
			"LOCKED",
			MEETING_CANCEL_COMPLETED_MESSAGE,
		);
		expect(await status()).toBe("completed");
	});

	it("cancelling twice and restoring a scheduled meeting are VALIDATION refusals with the exact sentences", async () => {
		await expectMcpError(
			restore(adminToken),
			"VALIDATION",
			MEETING_NOT_CANCELLED_MESSAGE,
		);
		await cancel(adminToken);
		await expectMcpError(
			cancel(adminToken),
			"VALIDATION",
			MEETING_ALREADY_CANCELLED_MESSAGE,
		);
	});

	it("an unknown meeting is NOT_FOUND before any write", async () => {
		await expectMcpError(cancel(adminToken, randomUUID()), "NOT_FOUND");
	});
});

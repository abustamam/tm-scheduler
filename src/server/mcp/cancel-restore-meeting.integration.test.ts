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
	guests,
	meetings,
	members,
	officerTerms,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
	user,
} from "#/db/schema";
import { MEETING_LOCKED_BLOCKING_MESSAGE } from "#/lib/assign-roles-plan";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
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
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { cancelMeetingTool } = await import("#/server/mcp/tools/cancel-meeting");
const { restoreMeetingTool } = await import(
	"#/server/mcp/tools/restore-meeting"
);
const { assignRolesTool } = await import("#/server/mcp/tools/assign-roles");
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

	it("assign_roles on a cancelled meeting is BLOCKED for every kind, and changes nothing (review of #1084)", async () => {
		// One assignment of EACH kind: a member onto the open Timer slot, a guest
		// onto a second Timer slot, and a clear of a speaker slot the member holds
		// with a linked speech — the clear being the write a restore could not
		// undo, since it drops `speech_id`.
		const [secondSlot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: seed.roleDefinitionId,
				slotIndex: 1,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		const [speakerRole] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		const [speech] = await testDb
			.insert(speeches)
			.values({ personId: seed.personId, title: "Ice Breaker" })
			.returning({ id: speeches.id });
		if (!secondSlot || !speakerRole || !speech) {
			throw new Error("fixture insert failed");
		}
		const [speakerSlot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: speakerRole.id,
				status: "claimed",
				assignedMemberId: seed.memberId,
				speechId: speech.id,
			})
			.returning({ id: roleSlots.id });
		const [guest] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: seed.clubId, name: "Visiting Vera" },
					testDb,
				),
			)
			.returning({ id: guests.id });
		if (!speakerSlot || !guest) throw new Error("fixture insert failed");

		const rows = () =>
			testDb
				.select({
					id: roleSlots.id,
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					assignedGuestId: roleSlots.assignedGuestId,
					speechId: roleSlots.speechId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, seed.meetingId))
				.orderBy(roleSlots.id);
		const assignments = [
			{ slotId: seed.slotId, memberId: seed.memberId },
			{ slotId: secondSlot.id, guestId: guest.id },
			{ slotId: speakerSlot.id, clear: true },
		];

		await cancel(adminToken);
		const before = await rows();

		const err = await assignRolesTool
			.handler(
				{ meetingId: seed.meetingId, assignments },
				{ rawToken: adminToken },
			)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(McpError);
		const blocked = err as InstanceType<typeof McpError> & {
			detail?: { blocking?: { code: string; message: string }[] };
		};
		expect(blocked.code).toBe("BLOCKED");
		const items = blocked.detail?.blocking ?? [];
		// The existing code, the cancelled sentence — and NOT the completed
		// meeting's sentence, which would send the officer to Reopen.
		expect(items).toContainEqual({
			code: "MEETING_LOCKED",
			message: MEETING_CANCELLED_MESSAGE,
		});
		expect(items.map((i) => i.message)).not.toContain(
			MEETING_LOCKED_BLOCKING_MESSAGE,
		);
		// Every row, every column, including the speech the clear would drop.
		expect(await rows()).toEqual(before);
		expect(before.find((r) => r.id === speakerSlot.id)?.speechId).toBe(
			speech.id,
		);

		// The control: the same batch is valid, and applies once restored — so
		// the block above was the cancellation and nothing else about it.
		await restore(adminToken);
		const applied = (await assignRolesTool.handler(
			{ meetingId: seed.meetingId, assignments },
			{ rawToken: adminToken },
		)) as { applied: boolean };
		expect(applied.applied).toBe(true);
		const after = await rows();
		expect(after.find((r) => r.id === seed.slotId)?.assignedMemberId).toBe(
			seed.memberId,
		);
		expect(after.find((r) => r.id === secondSlot.id)?.assignedGuestId).toBe(
			guest.id,
		);
		expect(after.find((r) => r.id === speakerSlot.id)?.status).toBe("open");
	});

	// Review of #1084, finding H: both tools' past-date branches.
	it("cancel_meeting on a meeting that has already started is VALIDATION with the exact sentence", async () => {
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(
			cancel(adminToken),
			"VALIDATION",
			MEETING_CANCEL_PAST_MESSAGE,
		);
		expect(await status()).toBe("scheduled");
	});

	it("restore_meeting on a cancelled meeting whose date has passed is VALIDATION with the exact sentence", async () => {
		await cancel(adminToken);
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
			.where(eq(meetings.id, seed.meetingId));
		await expectMcpError(
			restore(adminToken),
			"VALIDATION",
			MEETING_RESTORE_PAST_MESSAGE,
		);
		expect(await status()).toBe("cancelled");
	});
});

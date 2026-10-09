/**
 * DB-backed tests for `claimSlotCore` (#825).
 *
 * #825 moved `claimSlot`'s write out of its `createServerFn` handler so the
 * archive refusal could be executed — that half lives in
 * `public-writers-archive-gate.integration.test.ts`. What moved WITH it is
 * everything else the handler did, and a handler body is unreachable from
 * vitest, so until the move none of it was executed through the code that
 * ships. These pin each branch the core now owns, so deleting any one of its
 * calls fails a named case rather than nothing:
 *
 *   · the conditional UPDATE that is the race guard (one claim flips `open`);
 *   · the speaker branch that captures a Person-owned Speech (ADR-0009);
 *   · `markComingOnSelfClaim` — a self-claim says "coming", a claim by someone
 *     else does not;
 *   · the `claim` activity row;
 *   · the lock check on a LIVE club, which the archive cases cannot reach
 *     because the archive refusal throws first.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/slots-claim.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetingAttendancePlan,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { claimSlotCore } = await import("#/server/slots-logic");

const JUST_CLAIMED = "Sorry — this role was just claimed by someone else.";

let seeded: SeededClub | null = null;

afterEach(async () => {
	if (seeded) {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	}
});

async function seedLiveClub(): Promise<SeededClub> {
	const s = await seedClub();
	seeded = s;
	return s;
}

const claim = (
	slotId: string,
	memberId: string,
	actorMemberId: string | null,
	speakerDetails?: { speechTitle?: string },
) =>
	testDb.transaction((tx) =>
		claimSlotCore(tx, { slotId, memberId, actorMemberId, speakerDetails }),
	);

const slotRow = async (slotId: string) =>
	(
		await testDb
			.select({
				assignedMemberId: roleSlots.assignedMemberId,
				status: roleSlots.status,
				speechId: roleSlots.speechId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId))
	)[0] ?? null;

const planOf = async (memberId: string, meetingId: string) =>
	(
		await testDb
			.select({ status: meetingAttendancePlan.status })
			.from(meetingAttendancePlan)
			.where(
				and(
					eq(meetingAttendancePlan.memberId, memberId),
					eq(meetingAttendancePlan.meetingId, meetingId),
				),
			)
	)[0]?.status ?? null;

const claimsLogged = (clubId: string, slotId: string) =>
	testDb
		.select({
			actorMemberId: activityLog.actorMemberId,
			detail: activityLog.detail,
		})
		.from(activityLog)
		.where(
			and(
				eq(activityLog.clubId, clubId),
				eq(activityLog.action, "claim"),
				eq(activityLog.targetId, slotId),
			),
		);

async function seedOpenSpeakerSlot(s: SeededClub): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: s.clubId,
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
		})
		.returning({ id: roleDefinitions.id });
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: s.meetingId,
			roleDefinitionId: def!.id,
			status: "open",
		})
		.returning({ id: roleSlots.id });
	return slot!.id;
}

describe.skipIf(!hasTestDb)("claimSlotCore (#825)", () => {
	it("a self-claim takes the slot, logs a claim, and marks the member coming", async () => {
		const s = await seedLiveClub();
		await claim(s.slotId, s.memberId, s.memberId);

		expect(await slotRow(s.slotId)).toMatchObject({
			assignedMemberId: s.memberId,
			status: "claimed",
		});
		expect(await planOf(s.memberId, s.meetingId)).toBe("coming");
		expect(await claimsLogged(s.clubId, s.slotId)).toEqual([
			{ actorMemberId: s.memberId, detail: { memberId: s.memberId } },
		]);
	});

	it("a claim made FOR someone else does not answer their attendance for them", async () => {
		const s = await seedLiveClub();
		await claim(s.slotId, s.memberId, s.adminMemberId);

		expect((await slotRow(s.slotId))?.assignedMemberId).toBe(s.memberId);
		expect(await planOf(s.memberId, s.meetingId)).toBeNull();
		expect(await claimsLogged(s.clubId, s.slotId)).toEqual([
			{ actorMemberId: s.adminMemberId, detail: { memberId: s.memberId } },
		]);
	});

	/**
	 * The race guard. Sequential rather than concurrent, because what is under
	 * test is the `status = 'open'` predicate on the UPDATE — the thing that makes
	 * the loser lose — and a sequential second claim exercises exactly that
	 * predicate without depending on scheduling. Asserts the LOSER changed
	 * nothing: no holder swap, no second activity row, no attendance answer.
	 */
	it("the second claim of the same slot is refused and changes nothing", async () => {
		const s = await seedLiveClub();
		await claim(s.slotId, s.adminMemberId, s.adminMemberId);

		await expect(claim(s.slotId, s.memberId, s.memberId)).rejects.toThrow(
			JUST_CLAIMED,
		);
		expect((await slotRow(s.slotId))?.assignedMemberId).toBe(s.adminMemberId);
		expect(await claimsLogged(s.clubId, s.slotId)).toHaveLength(1);
		expect(await planOf(s.memberId, s.meetingId)).toBeNull();
	});

	it("claiming a speaker slot with a title captures a Speech owned by the claimant's Person", async () => {
		const s = await seedLiveClub();
		const slotId = await seedOpenSpeakerSlot(s);
		await claim(slotId, s.memberId, s.memberId, {
			speechTitle: "Ice Breaker",
		});

		const row = await slotRow(slotId);
		expect(row?.speechId).not.toBeNull();
		const [speech] = await testDb
			.select({ personId: speeches.personId, title: speeches.title })
			.from(speeches)
			.where(eq(speeches.id, row!.speechId!));
		const [claimant] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, s.memberId));
		expect(speech).toEqual({
			personId: claimant!.personId,
			title: "Ice Breaker",
		});
	});

	it("claiming a speaker slot with no details leaves it TBA", async () => {
		const s = await seedLiveClub();
		const slotId = await seedOpenSpeakerSlot(s);
		await claim(slotId, s.memberId, s.memberId);

		expect(await slotRow(slotId)).toMatchObject({
			assignedMemberId: s.memberId,
			speechId: null,
		});
	});

	/**
	 * The lock check on a LIVE club. The archive cases beside this suite's
	 * sibling archive the club first, so the archive refusal throws before this
	 * line is evaluated and deleting it would leave every one of them green.
	 */
	it("a live club's completed meeting refuses with the lock message", async () => {
		const s = await seedLiveClub();
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, s.meetingId));

		await expect(claim(s.slotId, s.memberId, s.memberId)).rejects.toThrow(
			MEETING_LOCKED_MESSAGE,
		);
		expect(await slotRow(s.slotId)).toMatchObject({
			assignedMemberId: null,
			status: "open",
		});
	});

	it("an unknown slot is refused", async () => {
		const s = await seedLiveClub();
		await expect(
			claim(crypto.randomUUID(), s.memberId, s.memberId),
		).rejects.toThrow("Role not found.");
	});
});

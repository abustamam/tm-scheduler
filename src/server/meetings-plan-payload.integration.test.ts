/**
 * The meeting payload carries the plan rungs the panel renders.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meetings-plan-payload.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { setPlanStatus } = await import("#/server/attendance-plan-logic");
const { loadMeetingDetailForTest } = await import("#/server/meetings-logic");

describe.skipIf(!hasTestDb)("meeting payload plan rungs", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("carries every rung, not just the unavailable ones", async () => {
		await setPlanStatus(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "coming",
			actorMemberId: seed.memberId,
		});
		await setPlanStatus(testDb, {
			memberId: seed.adminMemberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "reached_out",
			actorMemberId: seed.adminMemberId,
		});

		const payload = await loadMeetingDetailForTest(seed.meetingId, {
			canManage: true,
		});
		expect(
			[...payload.plan].sort((a, b) => a.status.localeCompare(b.status)),
		).toEqual([
			{ memberId: seed.memberId, status: "coming" },
			{ memberId: seed.adminMemberId, status: "reached_out" },
		]);
	});

	it("withholds the full plan from a non-managing caller", async () => {
		await setPlanStatus(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "reached_out",
			actorMemberId: seed.adminMemberId,
		});
		const payload = await loadMeetingDetailForTest(seed.meetingId, {
			canManage: false,
		});
		expect(payload.plan).toEqual([]);
	});

	it("NEVER puts reached_out on the public array, for either caller", async () => {
		// THE invariant of the two-array split. The strip needs a public array to
		// filter by the client-known member id, and `reached_out` is the officer's
		// private record of having asked — it rides the same table as the member's
		// own answer, so nothing but an explicit filter keeps it off the public
		// payload. This is the guard against re-opening the leak PR 1 closed.
		await setPlanStatus(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "reached_out",
			actorMemberId: seed.adminMemberId,
		});
		await setPlanStatus(testDb, {
			memberId: seed.adminMemberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "coming",
			actorMemberId: seed.adminMemberId,
		});

		for (const canManage of [true, false]) {
			const payload = await loadMeetingDetailForTest(seed.meetingId, {
				canManage,
			});
			// Anti-vacuity FIRST: an empty array satisfies "contains no
			// reached_out" for the wrong reason.
			expect(
				payload.answeredRungs.length,
				`answeredRungs was empty for canManage=${canManage}, so the assertion below proves nothing`,
			).toBe(1);
			expect(payload.answeredRungs).toEqual([
				{ memberId: seed.adminMemberId, status: "coming" },
			]);
			expect(payload.answeredRungs.map((r) => r.status)).not.toContain(
				"reached_out",
			);
		}
	});
});

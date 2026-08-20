/**
 * `loadMyCommitments` must stay ONE statement.
 *
 * The evaluator's project arrives through three extra left joins
 * (evaluates_slot_id → speaker slot → speech → catalog project). The obvious
 * wrong implementation resolves it per row, which is an N+1 over every upcoming
 * commitment a member holds across every club — and the RESULT is byte-identical
 * either way, so no assertion on the payload can fail. The observable is the
 * QUERY, so count at the driver.
 *
 * Counting at `db.$client` rather than spying a named loader is deliberate: a
 * spy on a helper goes green the moment someone inlines it, which is exactly the
 * refactor this test polices (see `src/test/query-spy.ts`).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/my-commitments-query.integration.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { meetings, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { readsOf, statementsDuring } from "#/test/query-spy";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadMyCommitments } = await import("./my-activity-logic");

const DAY = 24 * 60 * 60 * 1000;

/**
 * A club member holding `count` upcoming, confirmed role slots — no helper of
 * this name exists elsewhere in the repo, so this is written locally,
 * reusing `seedClub`'s member/role-definition rather than creating either
 * from scratch.
 */
async function seedMemberWithCommitments(opts: {
	count: number;
}): Promise<{ userId: string; clubId: string; adminUserId: string }> {
	const club: SeededClub = await seedClub();

	for (let i = 0; i < opts.count; i++) {
		const [meeting] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + (i + 1) * DAY),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		if (!meeting) throw new Error("meeting insert failed");

		await testDb.insert(roleSlots).values({
			meetingId: meeting.id,
			roleDefinitionId: club.roleDefinitionId,
			assignedMemberId: club.memberId,
			status: "confirmed",
		});
	}

	return {
		userId: club.memberUserId,
		clubId: club.clubId,
		adminUserId: club.adminUserId,
	};
}

describe.skipIf(!hasTestDb)("loadMyCommitments query shape", () => {
	it("reads role_slots once regardless of how many commitments exist", async () => {
		const { userId, clubId, adminUserId } = await seedMemberWithCommitments({
			count: 5,
		});
		try {
			const statements = await statementsDuring(() =>
				loadMyCommitments(userId),
			);

			// Non-empty first: an empty list makes every count below trivially pass,
			// which is how a broken spy reads as success.
			expect(
				statements.length,
				"no SQL was observed at all — the query spy has stopped working, so " +
					"this file tests nothing",
			).toBeGreaterThan(0);
			expect(readsOf(statements, "role_slots")).toHaveLength(1);
		} finally {
			await cleanup(clubId, [adminUserId, userId]);
		}
	});
});

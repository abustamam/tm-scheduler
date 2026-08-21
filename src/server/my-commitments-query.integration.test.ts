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
import { meetings, members, roleSlots, speeches } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import { readsOf, statementsDuring } from "#/test/query-spy";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadMyCommitments } = await import("./my-activity-logic");

const DAY = 24 * 60 * 60 * 1000;

/**
 * A club member holding `count` upcoming, confirmed EVALUATOR slots, each paired
 * to a speaker slot whose speech carries a project.
 *
 * The pairing is the whole point of the fixture, and an earlier version got it
 * wrong in a way that made this file unable to fail. It seeded `count` slots on
 * `seedClub`'s role definition — a Timer, `category: "functionary"` — with no
 * `evaluatesSlotId` and no `speechId`. The N+1 this file exists to catch is a
 * per-row resolution of the EVALUATED project, and the natural shape of that
 * wrong implementation is `if (row.evaluatesSlotId) { …query… }`. Against an
 * all-functionary fixture that branch never runs, so the wrong implementation
 * issues zero extra statements and the assertion passes.
 *
 * That is CLAUDE.md's "a fixture that spans ONE axis is not a guarantee" trap:
 * the axis that decides the branch — does this row have an evaluation target —
 * was the one held constant. Every seeded row now has one.
 */
async function seedMemberWithCommitments(opts: {
	count: number;
}): Promise<{ userId: string; clubId: string; adminUserId: string }> {
	const club: SeededClub = await seedClub();

	// A second member to hold the speaker slots, so the evaluator (our subject)
	// is evaluating someone else's speech, as in a real meeting.
	const speakerPersonId = await seedPerson({ name: "QA Speaker" });
	const [speakerMember] = await testDb
		.insert(members)
		.values({
			clubId: club.clubId,
			personId: speakerPersonId,
			name: "QA Speaker",
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	if (!speakerMember) throw new Error("speaker member insert failed");

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

		const [speech] = await testDb
			.insert(speeches)
			.values({
				personId: speakerPersonId,
				title: `QA speech ${i}`,
				projectName: "Ice Breaker",
				pathwayPath: "Presentation Mastery",
			})
			.returning({ id: speeches.id });
		if (!speech) throw new Error("speech insert failed");

		const [speakerSlot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: meeting.id,
				roleDefinitionId: club.roleDefinitionId,
				assignedMemberId: speakerMember.id,
				status: "confirmed",
				speechId: speech.id,
			})
			.returning({ id: roleSlots.id });
		if (!speakerSlot) throw new Error("speaker slot insert failed");

		// The subject's own row: an evaluator pointed at that speaker slot.
		await testDb.insert(roleSlots).values({
			meetingId: meeting.id,
			roleDefinitionId: club.roleDefinitionId,
			assignedMemberId: club.memberId,
			status: "confirmed",
			evaluatesSlotId: speakerSlot.id,
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

			// `speeches` is the table a per-row resolver would hit, once per
			// evaluator row. Five paired rows exist in this fixture, so an N+1
			// shows up here as 5+ reads even if `role_slots` were somehow still
			// read once. Counting only `role_slots` left the actual N+1 shape
			// unobserved.
			expect(readsOf(statements, "speeches").length).toBeLessThanOrEqual(1);
		} finally {
			await cleanup(clubId, [adminUserId, userId]);
		}
	});

	it("returns the evaluated project for every paired row", async () => {
		// Proves the fixture really is paired. Without this, a future edit that
		// silently dropped `evaluatesSlotId` from the seed would restore the
		// all-functionary blind spot with the query-count assertion still green.
		const { userId, clubId, adminUserId } = await seedMemberWithCommitments({
			count: 5,
		});
		try {
			const rows = await loadMyCommitments(userId);
			const evaluated = rows.filter((r) => r.evaluatedProjectName !== null);
			expect(evaluated).toHaveLength(5);
			for (const r of evaluated) {
				expect(r.evaluatedProjectName).toBe("Ice Breaker");
			}
		} finally {
			await cleanup(clubId, [adminUserId, userId]);
		}
	});
});

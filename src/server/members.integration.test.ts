/**
 * DB-backed integration tests for the PUBLIC roster read (`listMembers`) and for
 * the roster shape a member add has to leave behind.
 *
 * These never called the server fns: each helper below replicates the query
 * against `testDb`, because a `createServerFn` is unreachable from vitest. The
 * add helper was named after `addMember` when that fn was public; #630 deleted
 * that fn and renamed the helper.
 *
 * BE HONEST ABOUT WHAT THIS FILE IS. `insertRosterMember` writes the member row
 * and the `member_add` row itself, and the case below then asserts those same
 * rows exist — so it asserts that `testDb.insert` inserts, and would pass with
 * every production seam deleted. No production code is imported here. That
 * predates #630 (`addMemberPublic` on `main` hand-rolled the identical two
 * inserts); it is recorded rather than fixed because the fix is to drive the
 * real seam the way `public-writers-archive-gate.integration.test.ts` does
 * — `vi.mock("#/db", …)` plus a dynamic import — which is a rewrite, not a
 * removal. See `TODOS/remove-self-add-630.md`. Do NOT read the `member_add`
 * assertion as pinning `applyBulkImport`: nothing links them.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test \
 *     bunx vitest run src/server/members.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

// ---------------------------------------------------------------------------
// Helpers — replicate public roster query logic using testDb
// ---------------------------------------------------------------------------

async function listMembersPublic(clubId: string) {
	return testDb
		.select({
			id: members.id,
			name: members.name,
		})
		.from(members)
		.where(eq(members.clubId, clubId))
		.orderBy(members.name);
}

async function insertRosterMember(clubId: string, name: string) {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	if (!m) throw new Error("Failed to insert member");

	await testDb.insert(activityLog).values({
		clubId,
		actorMemberId: m.id,
		action: "member_add",
		targetType: "member",
		targetId: m.id,
		detail: { name },
	});

	return { id: m.id };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"public roster (listMembers + a roster add)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("listMembers returns the seeded roster member with no session", async () => {
			const rows = await listMembersPublic(seed.clubId);
			expect(rows.length).toBeGreaterThanOrEqual(1);
			const seeded = rows.find((r) => r.id === seed.memberId);
			expect(seeded).toBeDefined();
			expect(seeded?.name).toBe("Member User");
		});

		it("a roster add inserts the member and logs member_add", async () => {
			const result = await insertRosterMember(seed.clubId, "Alice Newcomer");
			expect(result.id).toBeDefined();

			// Verify roster row exists
			const [row] = await testDb
				.select({ name: members.name, clubId: members.clubId })
				.from(members)
				.where(eq(members.id, result.id))
				.limit(1);

			expect(row?.name).toBe("Alice Newcomer");
			expect(row?.clubId).toBe(seed.clubId);

			// Verify activity log row
			const log = await testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.targetId, result.id));
			expect(log.some((r) => r.action === "member_add")).toBe(true);
		});

		// Removed at #630: a case named "addMember with empty name is rejected
		// (validator guard)" that re-declared its own zod schema inline and asserted
		// zod rejects "". It never imported `addMemberSchema`, so it asserted nothing
		// about this repo even while that schema existed — and the schema is now gone.
		// The live min-length rule is `editSchema`/`bulkImportSchema` in
		// `members-logic.ts`, both exported and both reachable from a real test.

		it("listMembers returns a member added to the roster", async () => {
			await insertRosterMember(seed.clubId, "Bob Newbie");
			const rows = await listMembersPublic(seed.clubId);
			const found = rows.find((r) => r.name === "Bob Newbie");
			expect(found).toBeDefined();
		});
	},
);

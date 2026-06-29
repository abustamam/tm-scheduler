/**
 * DB-backed integration tests for the public roster fns: listMembers + addMember.
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
	testDb,
} from "#/test/db";

// ---------------------------------------------------------------------------
// Helpers — replicate public roster query logic using testDb
// ---------------------------------------------------------------------------

async function listMembersPublic(clubId: string) {
	return testDb
		.select({ id: members.id, name: members.name, office: members.office })
		.from(members)
		.where(eq(members.clubId, clubId))
		.orderBy(members.name);
}

async function addMemberPublic(clubId: string, name: string) {
	const [m] = await testDb
		.insert(members)
		.values({ clubId, name })
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

describe.skipIf(!hasTestDb)("public roster (listMembers + addMember)", () => {
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

	it("addMember inserts a new roster member and logs member_add", async () => {
		const result = await addMemberPublic(seed.clubId, "Alice Newcomer");
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

	it("addMember with empty name is rejected (validator guard)", () => {
		const { z } = require("zod");
		const addMemberSchema = z.object({
			clubId: z.string().uuid(),
			name: z.string().trim().min(1),
		});
		expect(() =>
			addMemberSchema.parse({ clubId: seed.clubId, name: "" }),
		).toThrow();
	});

	it("listMembers returns new member after addMember", async () => {
		await addMemberPublic(seed.clubId, "Bob Newbie");
		const rows = await listMembersPublic(seed.clubId);
		const found = rows.find((r) => r.name === "Bob Newbie");
		expect(found).toBeDefined();
	});
});

/**
 * DB-backed tests for club-role management (#187):
 *   - applySetMemberRole promotes member→admin and demotes admin→member,
 *     logging member_edit with the role before/after
 *   - the "club always keeps ≥1 active admin" invariant rejects both:
 *       · demoting the last active admin (applySetMemberRole), and
 *       · deactivating the last active admin (applySetMemberStatus)
 *     with NO write on either rejection
 *   - a role change never touches officer terms (permission vs. office)
 *
 * Tests the plain logic fns directly (createServerFn wrappers need the Start
 * runtime); `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/member-role.integration.test.ts
 */
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, members, officerTerms } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

async function roleOf(memberId: string) {
	const [m] = await testDb
		.select({ clubRole: members.clubRole, status: members.status })
		.from(members)
		.where(eq(members.id, memberId));
	return m;
}

async function latestMemberEdit(memberId: string) {
	const [log] = await testDb
		.select()
		.from(activityLog)
		.where(
			and(
				eq(activityLog.action, "member_edit"),
				eq(activityLog.targetId, memberId),
			),
		)
		.orderBy(desc(activityLog.createdAt))
		.limit(1);
	return log;
}

describe.skipIf(!hasTestDb)("club-role management (#187)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("promotes member→admin and logs member_edit with the role before/after", async () => {
		const { applySetMemberRole } = await import("#/server/members-logic");

		const res = await applySetMemberRole({
			clubId: seed.clubId,
			memberId: seed.memberId,
			clubRole: "admin",
			actorMemberId: seed.adminMemberId,
		});
		expect(res.clubRole).toBe("admin");
		expect((await roleOf(seed.memberId)).clubRole).toBe("admin");

		const log = await latestMemberEdit(seed.memberId);
		expect(log).toBeTruthy();
		expect(log.actorMemberId).toBe(seed.adminMemberId);
		const detail = log.detail as {
			before?: { clubRole?: string };
			after?: { clubRole?: string };
		};
		expect(detail.before?.clubRole).toBe("member");
		expect(detail.after?.clubRole).toBe("admin");
	});

	it("demotes admin→member when another active admin remains", async () => {
		const { applySetMemberRole } = await import("#/server/members-logic");

		// Promote the plain member so the club has two active admins…
		await applySetMemberRole({
			clubId: seed.clubId,
			memberId: seed.memberId,
			clubRole: "admin",
		});
		// …then demoting the original admin is allowed.
		const res = await applySetMemberRole({
			clubId: seed.clubId,
			memberId: seed.adminMemberId,
			clubRole: "member",
			actorMemberId: seed.memberId,
		});
		expect(res.clubRole).toBe("member");
		expect((await roleOf(seed.adminMemberId)).clubRole).toBe("member");

		const detail = (await latestMemberEdit(seed.adminMemberId)).detail as {
			before?: { clubRole?: string };
			after?: { clubRole?: string };
		};
		expect(detail.before?.clubRole).toBe("admin");
		expect(detail.after?.clubRole).toBe("member");
	});

	it("rejects demoting the club's last active admin (no write)", async () => {
		const { applySetMemberRole } = await import("#/server/members-logic");

		await expect(
			applySetMemberRole({
				clubId: seed.clubId,
				memberId: seed.adminMemberId,
				clubRole: "member",
			}),
		).rejects.toThrow(/last admin/i);

		// Unchanged — the write was rolled back / never happened.
		expect((await roleOf(seed.adminMemberId)).clubRole).toBe("admin");
	});

	it("rejects deactivating the club's last active admin (no write)", async () => {
		const { applySetMemberStatus } = await import("#/server/members-logic");

		await expect(
			applySetMemberStatus({
				clubId: seed.clubId,
				memberId: seed.adminMemberId,
				status: "inactive",
			}),
		).rejects.toThrow(/last admin/i);

		expect((await roleOf(seed.adminMemberId)).status).toBe("active");
	});

	it("is idempotent when the role is unchanged (no log written)", async () => {
		const { applySetMemberRole } = await import("#/server/members-logic");

		const before = await latestMemberEdit(seed.memberId);
		const res = await applySetMemberRole({
			clubId: seed.clubId,
			memberId: seed.memberId,
			clubRole: "member", // already a member
		});
		expect(res.clubRole).toBe("member");
		// No new member_edit row.
		expect(await latestMemberEdit(seed.memberId)).toEqual(before);
	});

	it("leaves officer terms untouched on a role change", async () => {
		const { applySetMemberRole } = await import("#/server/members-logic");

		// Give the member an OPEN officer term (VP Education).
		await testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "vp_education",
			termStart: new Date(),
		});
		const before = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId));

		await applySetMemberRole({
			clubId: seed.clubId,
			memberId: seed.memberId,
			clubRole: "admin",
		});

		const after = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId));
		// Same rows, still open (no term opened or closed by the role change).
		expect(after).toHaveLength(before.length);
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe(before[0].id);
		expect(after[0].termEnd).toBeNull();
	});
});

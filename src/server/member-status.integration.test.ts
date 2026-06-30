/**
 * DB-backed tests for roster member active/inactive status (#55):
 *   - applySetMemberStatus toggles status + logs member_edit
 *   - inactive members are excluded from member-facing listings
 *     (listMembers picker + season grid member list)
 *   - an inactive member's PAST assignments still resolve (history preserved)
 *
 * Tests the plain logic fns directly (createServerFn wrappers need the Start
 * runtime); `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/member-status.integration.test.ts
 */
import { and, desc, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, meetings, members, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

async function addMemberRow(clubId: string, name: string) {
	const [m] = await testDb
		.insert(members)
		.values({ clubId, name })
		.returning({ id: members.id });
	return m.id;
}

/** Mirrors the filtered `listMembers` server fn (active-only picker). */
async function listActiveMembers(clubId: string) {
	return testDb
		.select({ id: members.id, name: members.name })
		.from(members)
		.where(and(eq(members.clubId, clubId), ne(members.status, "inactive")))
		.orderBy(members.name);
}

describe.skipIf(!hasTestDb)("member active/inactive status", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("applySetMemberStatus toggles inactive↔active and logs member_edit", async () => {
		const { applySetMemberStatus } = await import("#/server/members-logic");
		const victim = await addMemberRow(seed.clubId, "Lapsed Larry");

		// → inactive
		const r1 = await applySetMemberStatus({
			clubId: seed.clubId,
			memberId: victim,
			status: "inactive",
			actorMemberId: seed.memberId,
		});
		expect(r1.status).toBe("inactive");
		const [afterOff] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, victim));
		expect(afterOff.status).toBe("inactive");

		const [log] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.action, "member_edit"),
					eq(activityLog.targetId, victim),
				),
			)
			.orderBy(desc(activityLog.createdAt))
			.limit(1);
		expect(log).toBeTruthy();
		const detail = log.detail as {
			before?: { status?: string };
			after?: { status?: string };
		};
		expect(detail.before?.status).toBe("active");
		expect(detail.after?.status).toBe("inactive");

		// → active again
		const r2 = await applySetMemberStatus({
			clubId: seed.clubId,
			memberId: victim,
			status: "active",
			actorMemberId: seed.memberId,
		});
		expect(r2.status).toBe("active");
		const [afterOn] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, victim));
		expect(afterOn.status).toBe("active");
	});

	it("applySetMemberStatus rejects a member from another club", async () => {
		const { applySetMemberStatus } = await import("#/server/members-logic");
		await expect(
			applySetMemberStatus({
				clubId: crypto.randomUUID(),
				memberId: seed.memberId,
				status: "inactive",
			}),
		).rejects.toThrow();
	});

	it("listMembers (picker) excludes inactive members but keeps active ones", async () => {
		const { applySetMemberStatus } = await import("#/server/members-logic");
		const active = await addMemberRow(seed.clubId, "Active Annie");
		const inactive = await addMemberRow(seed.clubId, "Inactive Ivan");
		await applySetMemberStatus({
			clubId: seed.clubId,
			memberId: inactive,
			status: "inactive",
		});

		const ids = (await listActiveMembers(seed.clubId)).map((m) => m.id);
		expect(ids).toContain(active);
		expect(ids).toContain(seed.memberId);
		expect(ids).not.toContain(inactive);
	});

	it("season grid excludes inactive members but their PAST assignment still resolves", async () => {
		const { applySetMemberStatus } = await import("#/server/members-logic");
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");

		// Pin the seeded meeting to the past and assign the soon-to-be-inactive
		// member to its slot (this is the history we must preserve).
		const pastDate = new Date("2020-02-02T19:00:00Z");
		await testDb
			.update(meetings)
			.set({ scheduledAt: pastDate })
			.where(eq(meetings.id, seed.meetingId));
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.memberId, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));

		await applySetMemberStatus({
			clubId: seed.clubId,
			memberId: seed.memberId,
			status: "inactive",
		});

		const data = await loadSeasonGrid({ clubId: seed.clubId, count: "all" });

		// Inactive member is gone from the member axis…
		expect(data.members.map((m) => m.id)).not.toContain(seed.memberId);
		// …but their past assignment cell still resolves (history preserved).
		const pastCell = data.cells.find(
			(c) => c.memberId === seed.memberId && c.meetingId === seed.meetingId,
		);
		expect(pastCell).toBeDefined();
		expect(pastCell?.status).toBe("claimed");
	});
});

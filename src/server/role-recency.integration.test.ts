/**
 * DB-backed tests for the assign-picker role-recency lookup (#146): "when did
 * this member last hold this role". `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/role-recency.integration.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { meetings, roleSlots } from "#/db/schema";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadRoleRecency, indexRoleRecency } = await import(
	"./role-recency-logic"
);

/** Insert a meeting and one slot of `roleDefinitionId` assigned to `memberId`. */
async function seedAssignedMeeting(opts: {
	clubId: string;
	roleDefinitionId: string;
	memberId: string | null;
	scheduledAt: Date;
	status?: "scheduled" | "cancelled" | "completed";
}) {
	const [meeting] = await testDb
		.insert(meetings)
		.values({
			clubId: opts.clubId,
			scheduledAt: opts.scheduledAt,
			status: opts.status ?? "completed",
		})
		.returning({ id: meetings.id });
	if (!meeting) throw new Error("Failed to insert meeting");
	await testDb.insert(roleSlots).values({
		meetingId: meeting.id,
		roleDefinitionId: opts.roleDefinitionId,
		assignedMemberId: opts.memberId,
		status: opts.memberId ? "confirmed" : "open",
	});
	return meeting.id;
}

describe.skipIf(!hasTestDb)("loadRoleRecency", () => {
	it("returns the most recent prior assignment, excluding cancelled/future/open", async () => {
		const club = await seedClub();
		const before = new Date("2026-07-10T00:00:00Z");
		const day = 86_400_000;

		// Older assignment.
		await seedAssignedMeeting({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			memberId: club.memberId,
			scheduledAt: new Date(before.getTime() - 30 * day),
		});
		// More recent assignment — this is the one we expect.
		const expectedAt = new Date(before.getTime() - 3 * day);
		await seedAssignedMeeting({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			memberId: club.memberId,
			scheduledAt: expectedAt,
		});
		// Cancelled meeting (more recent) — must NOT count.
		await seedAssignedMeeting({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			memberId: club.memberId,
			scheduledAt: new Date(before.getTime() - 1 * day),
			status: "cancelled",
		});
		// Meeting at/after the target date — must NOT count.
		await seedAssignedMeeting({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			memberId: club.memberId,
			scheduledAt: new Date(before.getTime() + 5 * day),
		});
		// Open (unassigned) slot in a prior meeting — must NOT produce a row.
		await seedAssignedMeeting({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			memberId: null,
			scheduledAt: new Date(before.getTime() - 2 * day),
		});

		try {
			const rows = await loadRoleRecency({ clubId: club.clubId, before });
			const mine = rows.filter(
				(r) =>
					r.roleDefinitionId === club.roleDefinitionId &&
					r.memberId === club.memberId,
			);
			expect(mine).toHaveLength(1);
			expect(mine[0]?.lastServedAt.toISOString()).toBe(
				expectedAt.toISOString(),
			);
		} finally {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		}
	});

	it("omits members who have never held the role", async () => {
		const club = await seedClub();
		const before = new Date("2026-07-10T00:00:00Z");
		try {
			const rows = await loadRoleRecency({ clubId: club.clubId, before });
			// Seed's lone slot is in a future, open meeting → no recency rows.
			expect(rows.some((r) => r.memberId === club.adminMemberId)).toBe(false);
		} finally {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		}
	});
});

describe("indexRoleRecency", () => {
	it("nests rows by roleDefinitionId then memberId as ISO strings", () => {
		const at = new Date("2026-06-01T00:00:00Z");
		const idx = indexRoleRecency([
			{ roleDefinitionId: "role-1", memberId: "m-1", lastServedAt: at },
			{ roleDefinitionId: "role-1", memberId: "m-2", lastServedAt: at },
			{ roleDefinitionId: "role-2", memberId: "m-1", lastServedAt: at },
		]);
		expect(idx["role-1"]?.["m-1"]).toBe(at.toISOString());
		expect(idx["role-1"]?.["m-2"]).toBe(at.toISOString());
		expect(idx["role-2"]?.["m-1"]).toBe(at.toISOString());
		expect(idx["role-2"]?.["m-2"]).toBeUndefined();
	});
});

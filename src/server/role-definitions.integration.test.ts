/**
 * DB-backed tests for the VPE/admin role-template management logic
 * (create / edit / reorder / delete). Tests the plain `applyX` / `listX` fns
 * directly (the createServerFn wrappers need the Start runtime); `#/db` is
 * redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/role-definitions.integration.test.ts
 */
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roleDefinitions, roleSlots } from "#/db/schema";
import { generateSlotRows } from "#/lib/agenda";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyRoleDefinitionCreate,
	applyRoleDefinitionUpdate,
	applyRoleDefinitionReorder,
	applyRoleDefinitionDelete,
	listRoleDefinitions,
} = await import("./role-definitions-logic");

async function orderedRoles(clubId: string) {
	return testDb
		.select({
			id: roleDefinitions.id,
			name: roleDefinitions.name,
			sortOrder: roleDefinitions.sortOrder,
		})
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId))
		.orderBy(asc(roleDefinitions.sortOrder));
}

describe.skipIf(!hasTestDb)("role-definition management", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("createRole appends a custom role after the seeded one (sortOrder = max+1)", async () => {
		const before = await orderedRoles(seed.clubId);
		const maxBefore = Math.max(...before.map((r) => r.sortOrder));

		const { id } = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Ah-Counter",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
			description: "Tracks filler words.",
		});

		const [row] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, id));
		expect(row.name).toBe("Ah-Counter");
		expect(row.description).toBe("Tracks filler words.");
		expect(row.sortOrder).toBe(maxBefore + 1);
	});

	it("createRole collapses an empty description to null", async () => {
		const { id } = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Grammarian",
			category: "functionary",
			defaultCount: 1,
			description: "   ",
		});
		const [row] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, id));
		expect(row.description).toBeNull();
		// defaults to non-speaker when the flag is omitted
		expect(row.isSpeakerRole).toBe(false);
	});

	it("updateRole edits description + fields; new defaultCount only affects future meetings", async () => {
		// Seeded role "Timer" already has one existing slot (seed.slotId).
		await applyRoleDefinitionUpdate({
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			name: "Timer",
			category: "functionary",
			defaultCount: 3,
			isSpeakerRole: false,
			description: "Times each speaker and signals with lights.",
		});

		const [row] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		expect(row.description).toBe("Times each speaker and signals with lights.");
		expect(row.defaultCount).toBe(3);

		// Existing meeting's slots are unchanged (still the single seeded slot).
		const existingSlots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.roleDefinitionId, seed.roleDefinitionId));
		expect(existingSlots.length).toBe(1);

		// A FUTURE meeting generated from the template would now get 3 Timer slots.
		const defs = await testDb
			.select({
				id: roleDefinitions.id,
				defaultCount: roleDefinitions.defaultCount,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		const rows = generateSlotRows(defs, "00000000-0000-0000-0000-000000000000");
		expect(rows.length).toBe(3);
	});

	it("listRoleDefinitions returns roles ordered by sortOrder with a slotCount", async () => {
		await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Speaker",
			category: "speaker",
			defaultCount: 2,
			isSpeakerRole: true,
		});
		const list = await listRoleDefinitions(seed.clubId);
		expect(list.length).toBe(2);
		// Seeded Timer (with a slot) first, then the new Speaker (no slots).
		expect(list[0].name).toBe("Timer");
		expect(list[0].slotCount).toBe(1);
		const speaker = list.find((r) => r.name === "Speaker");
		expect(speaker?.slotCount).toBe(0);
		expect(speaker?.isSpeakerRole).toBe(true);
		// Ordered ascending by sortOrder.
		expect(list[0].sortOrder).toBeLessThan(list[1].sortOrder);
	});

	it("reorderRoles rewrites sortOrder to match the given order", async () => {
		const a = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Alpha",
			category: "functionary",
			defaultCount: 1,
		});
		const b = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Beta",
			category: "functionary",
			defaultCount: 1,
		});

		// Reverse order: Beta, Alpha, Timer.
		await applyRoleDefinitionReorder({
			clubId: seed.clubId,
			orderedIds: [b.id, a.id, seed.roleDefinitionId],
		});

		const ordered = await orderedRoles(seed.clubId);
		expect(ordered.map((r) => r.id)).toEqual([
			b.id,
			a.id,
			seed.roleDefinitionId,
		]);
		expect(ordered.map((r) => r.sortOrder)).toEqual([0, 1, 2]);
	});

	it("reorderRoles rejects a stale id set (missing/extra ids)", async () => {
		await expect(
			applyRoleDefinitionReorder({
				clubId: seed.clubId,
				// Missing the seeded role; wrong set.
				orderedIds: ["00000000-0000-0000-0000-000000000001"],
			}),
		).rejects.toThrow();
	});

	it("deleteRole removes an unreferenced custom role", async () => {
		const { id } = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Disposable",
			category: "functionary",
			defaultCount: 1,
		});
		await applyRoleDefinitionDelete({ clubId: seed.clubId, roleId: id });
		const rows = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, id));
		expect(rows.length).toBe(0);
	});

	it("deleteRole blocks a role referenced by existing slots (no cascade)", async () => {
		// Seeded Timer role is referenced by seed.slotId.
		await expect(
			applyRoleDefinitionDelete({
				clubId: seed.clubId,
				roleId: seed.roleDefinitionId,
			}),
		).rejects.toThrow(/existing meetings/);

		// The role and its slot are both still present (history preserved).
		const [role] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		expect(role).toBeTruthy();
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId));
		expect(slot).toBeTruthy();
	});
});

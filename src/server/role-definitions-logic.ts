// VPE/admin role-template DB logic, split out from the createServerFn wrappers
// in `role-definitions.ts`. These are plain `applyX` / `listX` functions
// (directly integration-testable — the wrappers need the Start runtime). They
// MUST live here, away from the server-fn module, because `role-definitions.ts`
// is imported by the client app shell: the Start compiler strips the
// createServerFn handler bodies (and their `db` imports) from the client
// bundle, but a plain db-touching export sitting in that same module is NOT
// stripped and drags `pg` → `Buffer` into the browser (ReferenceError: Buffer
// is not defined). Keeping the db logic here keeps `pg` server-side. See the
// header of `members-logic.ts` and `server-modules.guard.test.ts`.
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { roleDefinitions, roleSlots } from "#/db/schema";

const roleCategory = z.enum([
	"leadership",
	"speaker",
	"evaluator",
	"functionary",
]);

export interface RoleDefinitionRow {
	id: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	sortOrder: number;
	isSpeakerRole: boolean;
	description: string | null;
	/** Number of existing slots referencing this role (blocks deletion when > 0). */
	slotCount: number;
}

/** The club's role template, ordered by sortOrder then name, each annotated with
 *  how many existing slots reference it (so the UI can disable deletion). */
export async function listRoleDefinitions(
	clubId: string,
): Promise<RoleDefinitionRow[]> {
	const rows = await db
		.select({
			id: roleDefinitions.id,
			name: roleDefinitions.name,
			category: roleDefinitions.category,
			defaultCount: roleDefinitions.defaultCount,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			description: roleDefinitions.description,
			slotCount: sql<number>`count(${roleSlots.id})::int`,
		})
		.from(roleDefinitions)
		.leftJoin(roleSlots, eq(roleSlots.roleDefinitionId, roleDefinitions.id))
		.where(eq(roleDefinitions.clubId, clubId))
		.groupBy(roleDefinitions.id)
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.name));
	return rows;
}

// Empty/whitespace-only descriptions collapse to null so a cleared field
// disappears from the agenda rather than persisting a blank string. Applied in
// the logic fns (below) so the behavior holds even when they're called directly
// (integration tests), not just through the schema.
const descriptionField = z.string().nullable().optional();

function normalizeDescription(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export const createRoleSchema = z.object({
	clubId: z.string().uuid(),
	name: z.string().trim().min(1),
	category: roleCategory,
	defaultCount: z.number().int().min(0).max(20),
	isSpeakerRole: z.boolean().optional(),
	description: descriptionField,
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

/** Append a new custom role to the club's template. New roles sort last (max
 *  sortOrder + 1). The caller is responsible for the admin authorization
 *  check (see `createClubRole`). Affects only meetings generated afterwards —
 *  existing meetings' slots are untouched. */
export async function applyRoleDefinitionCreate(input: CreateRoleInput) {
	const [{ maxSort }] = await db
		.select({
			maxSort: sql<number>`coalesce(max(${roleDefinitions.sortOrder}), -1)::int`,
		})
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, input.clubId));

	const [row] = await db
		.insert(roleDefinitions)
		.values({
			clubId: input.clubId,
			name: input.name,
			category: input.category,
			defaultCount: input.defaultCount,
			sortOrder: maxSort + 1,
			isSpeakerRole: input.isSpeakerRole ?? false,
			description: normalizeDescription(input.description),
		})
		.returning({ id: roleDefinitions.id });
	if (!row) throw new Error("Failed to create role.");
	return { id: row.id };
}

export const updateRoleSchema = z.object({
	clubId: z.string().uuid(),
	roleId: z.string().uuid(),
	name: z.string().trim().min(1),
	category: roleCategory,
	defaultCount: z.number().int().min(0).max(20),
	isSpeakerRole: z.boolean().optional(),
	description: descriptionField,
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

/** Edit an existing role's fields. Editing `defaultCount` only affects FUTURE
 *  generated meetings (via `generateSlotRows`); existing meetings' slots are
 *  unchanged. Description is read at display time, so edits go live everywhere
 *  (before-claim sheet + public shared link) immediately. The caller is
 *  responsible for the admin authorization check (see `updateClubRole`). */
export async function applyRoleDefinitionUpdate(input: UpdateRoleInput) {
	const [updated] = await db
		.update(roleDefinitions)
		.set({
			name: input.name,
			category: input.category,
			defaultCount: input.defaultCount,
			isSpeakerRole: input.isSpeakerRole ?? false,
			description: normalizeDescription(input.description),
		})
		.where(
			and(
				eq(roleDefinitions.id, input.roleId),
				eq(roleDefinitions.clubId, input.clubId),
			),
		)
		.returning({ id: roleDefinitions.id });
	if (!updated) throw new Error("Role not found.");
	return { ok: true as const };
}

export const reorderRolesSchema = z.object({
	clubId: z.string().uuid(),
	// The full set of role ids in the desired order.
	orderedIds: z.array(z.string().uuid()).min(1),
});
export type ReorderRolesInput = z.infer<typeof reorderRolesSchema>;

/** Persist a new role ordering by assigning sortOrder = array index. Rejects the
 *  request unless `orderedIds` is exactly the club's current role id set (so a
 *  stale client can't drop or smuggle in a row). New sortOrders are honored
 *  wherever roles are listed and generated. */
export async function applyRoleDefinitionReorder(input: ReorderRolesInput) {
	const existing = await db
		.select({ id: roleDefinitions.id })
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, input.clubId));
	const existingIds = new Set(existing.map((r) => r.id));
	const orderedSet = new Set(input.orderedIds);
	if (
		existingIds.size !== orderedSet.size ||
		input.orderedIds.some((id) => !existingIds.has(id))
	) {
		throw new Error("Role ordering is out of date — reload and try again.");
	}

	await db.transaction(async (tx) => {
		for (let i = 0; i < input.orderedIds.length; i++) {
			await tx
				.update(roleDefinitions)
				.set({ sortOrder: i })
				.where(
					and(
						eq(roleDefinitions.id, input.orderedIds[i]),
						eq(roleDefinitions.clubId, input.clubId),
					),
				);
		}
	});
	return { ok: true as const };
}

export const deleteRoleSchema = z.object({
	clubId: z.string().uuid(),
	roleId: z.string().uuid(),
});
export type DeleteRoleInput = z.infer<typeof deleteRoleSchema>;

/** Delete a custom role. BLOCKED with a clear message when the role is
 *  referenced by any existing meeting's slots — we never cascade-delete
 *  historical slots (the FK is onDelete: "restrict" as a backstop). The caller
 *  is responsible for the admin authorization check (see `deleteClubRole`). */
export async function applyRoleDefinitionDelete(input: DeleteRoleInput) {
	const [role] = await db
		.select({ id: roleDefinitions.id })
		.from(roleDefinitions)
		.where(
			and(
				eq(roleDefinitions.id, input.roleId),
				eq(roleDefinitions.clubId, input.clubId),
			),
		)
		.limit(1);
	if (!role) throw new Error("Role not found.");

	const [{ count }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(roleSlots)
		.where(eq(roleSlots.roleDefinitionId, input.roleId));
	if (count > 0) {
		throw new Error(
			"This role is used by existing meetings and can't be deleted. " +
				"Set its default count to 0 to stop adding it to new meetings.",
		);
	}

	await db
		.delete(roleDefinitions)
		.where(
			and(
				eq(roleDefinitions.id, input.roleId),
				eq(roleDefinitions.clubId, input.clubId),
			),
		);
	return { ok: true as const };
}

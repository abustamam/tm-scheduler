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
import { pairedRoleIds } from "#/lib/meeting-roles";
import { isReadableClub } from "./club-readable-logic";
import { roleDefScopeOnly } from "./meeting-templates-logic";
import { syncSlotsForRoleEnabledChange } from "./slots-logic";

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
	/** Number of existing slots referencing this role (blocks deletion when > 0).
	 *  `undefined` unless the caller asked for it — computing it costs an
	 *  aggregate join over `role_slots`, which only the admin roles page needs.
	 *  See `listRoleDefinitions`'s `withSlotCounts`. */
	slotCount?: number;
	/** Whether new meetings generate slots for this role (#368). Disabled roles
	 *  stay in this list — never deleted, never hidden from admin — they just
	 *  stop being offered anywhere a role is filled. */
	enabled: boolean;
}

/** The club's role template, ordered by sortOrder then name, each annotated with
 *  how many existing slots reference it (so the UI can disable deletion) and
 *  whether it's enabled. By default includes disabled roles (the admin-only
 *  listing keeps them visible/retrievable, #368); pass `onlyEnabled: true` for
 *  any surface that OFFERS a role to be filled — the single tested path both
 *  `getPublicClubRoles` (the printable sheet) and `loadMeetingDetail`'s
 *  "+ Add role" picker (`meetings.ts`) route through, so that rule lives in one
 *  place instead of being re-expressed as a separate filter/query at each
 *  call site where it could drift. */
export async function listRoleDefinitions(
	clubId: string,
	opts?: {
		onlyEnabled?: boolean;
		withSlotCounts?: boolean;
		/** Which slot source to list (#agenda-templates). `null` (the default) is
		 *  the club's OWN standard roles — what `/admin/roles` edits. A meeting
		 *  template's id lists that template's materialized roles instead.
		 *
		 *  A parameter rather than a hard `isNull` inside this function, because
		 *  `loadMeetingDetail`'s "+ Add role" picker routes through here too
		 *  (`meetings.ts:322`): hard-coding the standard scope would offer a
		 *  contest meeting only the club's standard roles, leaving no way to add
		 *  a contestant and no way to change the contestant count. */
		templateId?: string | null;
	},
): Promise<RoleDefinitionRow[]> {
	const where = [
		eq(roleDefinitions.clubId, clubId),
		roleDefScopeOnly(opts?.templateId ?? null),
	];
	if (opts?.onlyEnabled) where.push(eq(roleDefinitions.enabled, true));

	const base = {
		id: roleDefinitions.id,
		name: roleDefinitions.name,
		category: roleDefinitions.category,
		defaultCount: roleDefinitions.defaultCount,
		sortOrder: roleDefinitions.sortOrder,
		isSpeakerRole: roleDefinitions.isSpeakerRole,
		description: roleDefinitions.description,
		enabled: roleDefinitions.enabled,
	};
	const order = [
		asc(roleDefinitions.sortOrder),
		asc(roleDefinitions.name),
	] as const;

	// `slotCount` costs a leftJoin + groupBy across `role_slots` — a table that
	// grows with every meeting of EVERY club, not just this one. Only the admin
	// roles page reads it (to block deleting a role already in use), so the
	// aggregate is opt-in. The PUBLIC readers (`getPublicClubRoles`, which now
	// serves both the printed sheet and the roles guide, and the "+ Add role"
	// picker) skip it and stay a plain indexed lookup on `role_definitions_club_idx`
	// — they are reachable unauthenticated and the router preloads on hover
	// (`defaultPreload: "intent"`, `preloadStaleTime: 0`), so a hover would
	// otherwise fire the aggregate.
	if (!opts?.withSlotCounts) {
		return db
			.select(base)
			.from(roleDefinitions)
			.where(and(...where))
			.orderBy(...order);
	}

	return db
		.select({ ...base, slotCount: sql<number>`count(${roleSlots.id})::int` })
		.from(roleDefinitions)
		.leftJoin(roleSlots, eq(roleSlots.roleDefinitionId, roleDefinitions.id))
		.where(and(...where))
		.groupBy(roleDefinitions.id)
		.orderBy(...order);
}

/**
 * PUBLIC (no-session) variant of {@link listRoleDefinitions} — the seam behind
 * `getPublicClubRoles`, which serves both the printable role sheet (#341) and
 * the in-chrome roles guide (#318).
 *
 * Returns `[]` for an archived (or unknown) club (#544). A separate named
 * function rather than an `isPublic` flag on `listRoleDefinitions`, for two
 * reasons: the authed caller (`listClubRoles`) is already archive-gated by
 * `requireClubViewAccess` → `requireMembership`, so putting the check inside the
 * shared function would bill every admin read for a second round trip it does
 * not need; and — as with `loadPublicSeasonGrid` — a named seam is testable,
 * whereas the `createServerFn` handler that used to hold this call is not.
 */
export async function loadPublicClubRoles(
	clubId: string,
): Promise<RoleDefinitionRow[]> {
	if (!(await isReadableClub(clubId))) return [];
	return listRoleDefinitions(clubId, { onlyEnabled: true });
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
 *  responsible for the admin authorization check (see `updateClubRole`).
 *
 *  Deliberately does NOT touch `enabled` — see `applyRoleDefinitionSetEnabled`
 *  below, a separate narrow action (#368) so a plain field edit here can never
 *  discard an admin's in-progress toggle (or vice versa) under last-write-wins,
 *  and so this function doesn't need to read-before-write to detect a flip. */
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

export const setRoleEnabledSchema = z.object({
	clubId: z.string().uuid(),
	roleId: z.string().uuid(),
	enabled: z.boolean(),
});
/** The actor is NOT on the wire (#396): `setClubRoleEnabled` gates on the club
 *  admin role and credits the membership that guard resolved from the session. */
export type SetRoleEnabledInput = z.infer<typeof setRoleEnabledSchema> & {
	actorMemberId: string | null;
};

/** Toggle a role's `enabled` flag (#368) — a narrow action, separate from
 *  `applyRoleDefinitionUpdate`, that posts only `{ clubId, roleId, enabled }`
 *  rather than a whole-row snapshot taken from a loader. A whole-row toggle
 *  would silently discard any unsaved edits typed into the same card and
 *  last-write-wins against a concurrent admin editing other fields; this can't,
 *  since it never writes name/category/defaultCount/etc.
 *
 *  A club can't delete a standard role once any meeting has used it
 *  (`role_slots.role_definition_id` is ON DELETE RESTRICT) — `enabled` is the
 *  lever instead. Writing the flag runs `syncSlotsForRoleEnabledChange`:
 *  disabling drops the role's open, unclaimed slots from future, non-cancelled
 *  meetings (never a claimed one); enabling backfills them back in (skipped for
 *  the paired Speaker/Evaluator roles — see that function's docstring).
 *
 *  This is an IDEMPOTENT RECONCILE, not a flip-detecting no-op: setting the flag
 *  to the value it already holds still runs the slot sync. That is deliberate.
 *  The flag UPDATE and the slot sync are separate statements, so a sync that
 *  throws (a deadlock against the PUBLIC, no-auth `claimSlot`, a connection
 *  blip, a large `meetingIds` set) leaves the flag persisted and the slots
 *  unsynced — the role reads Disabled in the admin UI, is hidden from the
 *  "+ Add role" picker and the public role sheet, yet every future meeting still
 *  carries its open slot, still printed on the agenda and still claimable by a
 *  guest. Short-circuiting on `enabled` already matching made retrying the same
 *  action do nothing, so the only escape from that state was Enable → Disable.
 *  Re-running the action now repairs it. The cost is that a redundant toggle
 *  does real (harmless, presence-based) slot work; it reports what it actually
 *  did, so the toast stays honest.
 *
 *  Returns `keptClaimedMeetings` (upcoming meetings that still have the role
 *  assigned to someone, disable-only) and `meetingsChanged` (upcoming meetings
 *  that actually gained/lost a slot) so the caller can build an informative
 *  toast either way instead of discarding what the slot sync already computed.
 *  Both are 0 when the slots already agree with the flag. */
export async function applyRoleDefinitionSetEnabled(
	input: SetRoleEnabledInput,
) {
	// Read for the sync's inputs (and to reject a role that isn't this club's) —
	// NOT to detect a flip: the reconcile runs either way, see above.
	const [current] = await db
		.select({
			name: roleDefinitions.name,
			defaultCount: roleDefinitions.defaultCount,
		})
		.from(roleDefinitions)
		.where(
			and(
				eq(roleDefinitions.id, input.roleId),
				eq(roleDefinitions.clubId, input.clubId),
			),
		)
		.limit(1);
	if (!current) throw new Error("Role not found.");

	/**
	 * The Speaker role and its paired Evaluator cannot be disabled (#512).
	 *
	 * They are not optional the way the `enabled` flag's other subjects are: a
	 * meeting without prepared speeches is not a meeting, and the run of show
	 * hangs beats off them — speeches, best-speaker voting, evaluations,
	 * best-evaluator voting. A club running one meeting without speeches
	 * expresses that per meeting, with zero speaker slots, not by turning the
	 * role off club-wide.
	 *
	 * The rest of the app already treats this pair as special and off-limits to
	 * generic controls: `applyAddRoleSlot` and `applyRemoveRoleSlot` both refuse
	 * them outright ("Remove speakers with the speaker controls") because they
	 * belong to the dedicated +/− buttons. This toggle was the one remaining way
	 * to mutate their slots without going through those buttons — an
	 * inconsistency, not a capability.
	 *
	 * And it orphaned pairings. Disabling Speaker sends `removeOpenRoleSlots` to
	 * delete every open speaker slot for one `role_definition_id`, touching no
	 * other role, so every evaluator linked to one of them has its
	 * `evaluates_slot_id` silently nulled by the FK and is left evaluating
	 * nobody. That is the same defect `applyRemoveSpeakerSlot` was just fixed
	 * for, reached by a different path.
	 *
	 * Only DISABLING is blocked. Re-enabling stays allowed so a club that turned
	 * one off before this existed can put it back.
	 */
	if (!input.enabled) {
		const defs = await db
			.select({
				id: roleDefinitions.id,
				category: roleDefinitions.category,
				defaultCount: roleDefinitions.defaultCount,
				sortOrder: roleDefinitions.sortOrder,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, input.clubId));
		if (pairedRoleIds(defs).has(input.roleId)) {
			throw new Error(
				`${current.name} can't be disabled — every meeting needs speakers and their evaluators. ` +
					`Set its count to 0 on a meeting instead.`,
			);
		}
	}

	await db
		.update(roleDefinitions)
		.set({ enabled: input.enabled })
		.where(
			and(
				eq(roleDefinitions.id, input.roleId),
				eq(roleDefinitions.clubId, input.clubId),
			),
		);

	const result = await syncSlotsForRoleEnabledChange({
		clubId: input.clubId,
		roleDefinitionId: input.roleId,
		roleName: current.name,
		defaultCount: current.defaultCount,
		enabled: input.enabled,
		actorMemberId: input.actorMemberId,
	});
	return {
		ok: true as const,
		keptClaimedMeetings: result.keptClaimedMeetings,
		meetingsChanged: result.meetingsChanged,
	};
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
				"Disable it instead — future meetings stop offering it, its history " +
				"stays intact, and you can turn it back on later.",
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

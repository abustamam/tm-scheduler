/**
 * Role identity: deriving a role's `key`, and matching one set of role
 * definitions onto another by the identity that survives a copy.
 *
 * `role_definitions` rows used to be MATERIALIZED per (club, template), so the
 * same conceptual role — "Contest Chair" — was a DIFFERENT row with a fresh
 * `id` every time a template was copied or re-applied. #801 ended that: a role
 * definition is now one row per (club, key), `role_slots.role_definition_id`
 * points at it from every shape, and a conversion or a fork no longer moves
 * any id.
 *
 * `matchRoleDefs` survives that change with a NARROWER remaining job. It is no
 * longer a translation between two id spaces — the id space is one — it is the
 * keep/drop decision: given the roles a meeting's slots currently reference and
 * the roles a target shape declares, which slots survive. The match is by `key`
 * (the stable, rename-proof identity #368 exists for) with a `name` fallback
 * for a row that has no key, because a declaration and a bank row agree on the
 * key and need not agree on anything else. Its matched entries are now usually
 * identity mappings (`from.id === to.id`), and callers treat a no-move match as
 * a no-op rather than as evidence they matched nothing.
 *
 * Pure, and in `lib/` rather than beside its callers, for the reason
 * CLAUDE.md records: a module that imports `#/db` at load is unassertable
 * from a plain unit test, and these rules decide whether a member keeps a role
 * they claimed and whether a typed-in name attaches or forks. `matchRoleDefs`
 * has two callers that MUST agree — `planTemplateConversion` (what the dialog
 * promises) and `applyTemplateConversion` (what actually happens);
 * `deriveRoleKey` has two that must agree for a different reason, below.
 */

/**
 * `Zoom Master` → `zoom_master`, uniquified against `taken`.
 *
 * Keys are the stable, rename-proof identity every surface binds on (#368), so
 * they are derived once at creation and never follow a later rename.
 *
 * WHAT `taken` MUST BE is the whole of this docblock. The binding constraint is
 * `role_definitions_club_key_unique`, one row per (club_id, key) — so a caller
 * minting a bank row passes the CLUB's existing keys, not one template's. Both
 * writers do: `addAgendaRole`'s create arm (meeting-agenda-edit-logic.ts) and
 * `applyRoleDefinitionCreate` (role-definitions-logic.ts), which wrote no key
 * at all until #801 and so left every club-invented role unable to be declared
 * by any agenda (`meeting_template_roles.key` is NOT NULL).
 *
 * Uniquifying against a template's declarations instead is what the agenda
 * editor used to do, and it was only safe while `role_definitions` was keyed
 * per (club, template) and `removeAgendaRole` deleted the definition alongside
 * the declaration. Neither is true now: the bank row OUTLIVES its declarations
 * by design, which is what makes re-adding a removed name re-attach the same
 * row instead of colliding.
 */
export function deriveRoleKey(name: string, taken: Set<string>): string {
	const base =
		[...name.toLowerCase()]
			.map((c) => (/[a-z0-9]/.test(c) ? c : "_"))
			.join("")
			.replace(/_+/g, "_")
			.replace(/^_|_$/g, "") || "role";
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}_${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** The half of a role definition that survives a copy. */
export type RoleIdentity = { key: string | null; name: string };

/** A role definition as the matcher consumes it: an identity plus the id the
 *  caller wants back. */
export type IdentifiedRole = RoleIdentity & { id: string };

/**
 * Map each `from` definition onto the `to` definition that IS the same role.
 *
 * Keyed rows match by `key` and ONLY by `key`: a keyed definition whose key is
 * absent from `to` is left unmatched rather than guessed at by name. Unkeyed
 * rows (a legacy row, or a club-invented custom role predating #368) match by
 * case-insensitive `name` instead — a STRICT either/or, which is what keeps
 * this narrower than `matchesRole` (agenda-runsheet.ts): that function falls
 * back to name because a SLOT carries no key of its own to be strict about,
 * while a `role_definitions` row does.
 *
 * An AMBIGUOUS name in `to` — two definitions sharing it, which no unique
 * index stops and `addAgendaRole` deliberately allows for two roles with
 * different keys — matches NOTHING, rather than landing nondeterministically
 * on whichever row an unordered `select()` happened to return last.
 *
 * Returns only the entries that matched, so `result.has(id)` is exactly "this
 * role survives" and `result.get(id)` is what it becomes.
 */
export function matchRoleDefs<T extends RoleIdentity>(
	from: IdentifiedRole[],
	to: T[],
): Map<string, T> {
	const byKey = new Map<string, T>();
	const byName = new Map<string, T | null>();
	for (const candidate of to) {
		if (candidate.key != null) byKey.set(candidate.key, candidate);
		const nameKey = candidate.name.toLowerCase();
		byName.set(nameKey, byName.has(nameKey) ? null : candidate);
	}

	const matched = new Map<string, T>();
	for (const def of from) {
		const hit =
			def.key != null
				? byKey.get(def.key)
				: (byName.get(def.name.toLowerCase()) ?? undefined);
		if (hit) matched.set(def.id, hit);
	}
	return matched;
}

/**
 * The distinct role definitions a set of slots references, as
 * `matchRoleDefs` wants them.
 *
 * A meeting has many slots per role, and matching is per DEFINITION — running
 * the map build once per slot would be the same answer at N times the cost,
 * and would make the returned map's key space slot ids rather than definition
 * ids.
 */
export function distinctRoleDefs(
	slots: {
		roleDefinitionId: string;
		roleKey: string | null;
		roleName: string;
	}[],
): IdentifiedRole[] {
	const seen = new Map<string, IdentifiedRole>();
	for (const slot of slots) {
		if (seen.has(slot.roleDefinitionId)) continue;
		seen.set(slot.roleDefinitionId, {
			id: slot.roleDefinitionId,
			key: slot.roleKey,
			name: slot.roleName,
		});
	}
	return [...seen.values()];
}

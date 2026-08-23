/**
 * Matching one set of role definitions onto another, by the identity that
 * survives a copy.
 *
 * `role_definitions` rows are MATERIALIZED per (club, template), so the same
 * conceptual role — "Contest Chair" — is a DIFFERENT row with a fresh `id`
 * every time a template is copied or re-applied. Anything reasoning about
 * "does this slot's role still exist after the change" therefore cannot
 * compare ids; it has to compare `key` (the stable, rename-proof identity
 * #368 exists for) and fall back to `name` only for a row that has no key.
 *
 * Pure, and in `lib/` rather than beside its callers, for the reason
 * CLAUDE.md records: a module that imports `#/db` at load is unassertable
 * from a plain unit test, and this rule decides whether a member keeps a role
 * they claimed. It has two callers that MUST agree — `planTemplateConversion`
 * (what the dialog promises) and `applyTemplateConversion` (what actually
 * happens) — plus `ensureAgendaDraft`'s fork, which is where the rule was
 * first written.
 */

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

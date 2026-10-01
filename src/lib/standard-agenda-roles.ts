/**
 * Which roles a materialised STANDARD agenda declares (#910) — the rule
 * `declaredRolesForSeeds` (`meeting-agenda-edit-logic.ts`) applies to the
 * club's role bank. Pure and `#/db`-free so every branch is a unit test.
 *
 * Why it is not simply "the keys the beats name": the standard run of show
 * binds only five role keys to rows (Toastmaster, Speaker, Table Topics
 * Master, General Evaluator, Evaluator). The functionaries are introduced
 * through `{roles:…}` tokens inside the Toastmaster's text, not bound rows. A
 * declaration list of the named keys alone therefore left the Timer,
 * Ah-Counter, Grammarian and Vote Counter out of every materialised copy and
 * every club template saved from one — and a meeting created on such a
 * template (the club default agenda) generates its slots from the
 * declarations, so it silently lost all four.
 *
 * The rule, which reproduces the slots a standard meeting generates today
 * (`generateSlotRows`: the club's standing, enabled roles):
 *
 *  - every beat-named key, in the order the beats name them. One the club RUNS
 *    (a standing, enabled row with that key) at the club's own count; one it
 *    does not (switched off, not standing, or absent) with NO places, so its
 *    row still prints — owned by nobody, as an unstaffed role does — without
 *    a skeleton-crew club getting a slot for a role it turned off;
 *  - then every other keyed role the club runs, at its own count, in the
 *    bank's order.
 *
 * A role with no `key` (a legacy club-invented row from before #801) cannot be
 * declared — `meeting_template_roles.key` is NOT NULL.
 */

export type StandardRoleCategory =
	| "leadership"
	| "speaker"
	| "evaluator"
	| "functionary";

/** One club `role_definitions` row, as the rule reads it. */
export type BankRole = {
	key: string | null;
	name: string;
	category: StandardRoleCategory;
	defaultCount: number;
	isSpeakerRole: boolean;
	slotsUnordered: boolean;
	standing: boolean;
	enabled: boolean;
};

/** One `meeting_template_roles` declaration. */
export type DeclaredStandardRole = {
	key: string;
	name: string;
	category: StandardRoleCategory;
	defaultCount: number;
	isSpeakerRole: boolean;
	slotsUnordered: boolean;
	sortOrder: number;
};

/** Whether the club runs this role on a standard meeting. */
function runs(role: BankRole): role is BankRole & { key: string } {
	return role.key != null && role.standing && role.enabled;
}

export function declareStandardRoles(
	namedKeys: readonly string[],
	bank: readonly BankRole[],
): DeclaredStandardRole[] {
	const byKey = new Map(
		bank.flatMap((r) => (r.key == null ? [] : [[r.key, r] as const])),
	);
	const named = namedKeys.map((key, i): DeclaredStandardRole => {
		const club = byKey.get(key);
		return {
			key,
			// A key the club does not define falls back to the key itself rather
			// than dropping the beat: `toRow` drops a role beat whose key is not
			// declared, and the row should still print, owned by nobody.
			name: club?.name ?? key,
			category: club?.category ?? "functionary",
			defaultCount: club && runs(club) ? club.defaultCount : 0,
			isSpeakerRole: club?.isSpeakerRole ?? false,
			slotsUnordered: club?.slotsUnordered ?? false,
			sortOrder: i,
		};
	});
	const namedSet = new Set(namedKeys);
	const others = bank
		.filter(runs)
		.filter((r) => !namedSet.has(r.key))
		.map(
			(r, i): DeclaredStandardRole => ({
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				isSpeakerRole: r.isSpeakerRole,
				slotsUnordered: r.slotsUnordered,
				sortOrder: namedKeys.length + i,
			}),
		);
	return [...named, ...others];
}

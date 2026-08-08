// src/lib/role-categories.ts
//
// The display vocabulary for `role_definitions.category` — the order categories
// render in, their human labels, and the grouping itself.
//
// Extracted for #318. Two surfaces now render a club's roles from the same
// `getPublicClubRoles` data: the printable one-pager (`ClubRoleSheet`, #341) and
// the in-chrome readable guide a guest reaches from the club page. They must
// group and order identically — a guest who reads the page and then prints the
// sheet should see the same thing in the same order.
//
// Client-safe: no `#/db` import, so a unit test can assert the grouping without
// a database (see the `DATABASE_URL is not set` trap in CLAUDE.md).

/** Mirrors `roleCategoryEnum` in `src/db/schema.ts`. */
export type RoleCategory =
	| "leadership"
	| "speaker"
	| "evaluator"
	| "functionary";

/**
 * Categories render top-to-bottom in this order. It follows the shape of a
 * meeting — who runs it, who speaks, who evaluates, who supports — rather than
 * the enum's declaration order, which is incidental.
 */
export const CATEGORY_ORDER: readonly RoleCategory[] = [
	"leadership",
	"speaker",
	"evaluator",
	"functionary",
];

export const CATEGORY_LABEL: Record<RoleCategory, string> = {
	leadership: "Leadership",
	speaker: "Speaking Roles",
	evaluator: "Evaluation",
	functionary: "Functionary Roles",
};

export type RoleCategoryGroup<T> = {
	category: RoleCategory;
	label: string;
	roles: T[];
};

/**
 * Group roles by category in `CATEGORY_ORDER`, dropping empty categories.
 *
 * Empty groups are dropped rather than rendered with a heading and nothing
 * under it: a "skeleton crew" club turns roles off (`role_definitions.enabled`,
 * #368) and `getPublicClubRoles` filters those out, so a whole category can
 * legitimately be empty. Within a category the caller's order is preserved —
 * `listRoleDefinitions` already sorts by `sort_order`.
 */
export function groupRolesByCategory<T extends { category: RoleCategory }>(
	roles: T[],
): RoleCategoryGroup<T>[] {
	return CATEGORY_ORDER.map((category) => ({
		category,
		label: CATEGORY_LABEL[category],
		roles: roles.filter((r) => r.category === category),
	})).filter((g) => g.roles.length > 0);
}

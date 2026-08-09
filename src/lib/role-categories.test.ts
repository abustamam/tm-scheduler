import { describe, expect, it } from "vitest";
import { roleCategoryEnum } from "#/db/schema";
import {
	CATEGORY_LABEL,
	CATEGORY_ORDER,
	groupRolesByCategory,
	type RoleCategory,
} from "./role-categories";

type R = { id: string; category: RoleCategory };
const r = (id: string, category: RoleCategory): R => ({ id, category });

describe("groupRolesByCategory", () => {
	it("orders categories by CATEGORY_ORDER, not by input order", () => {
		const groups = groupRolesByCategory([
			r("f", "functionary"),
			r("l", "leadership"),
			r("e", "evaluator"),
			r("s", "speaker"),
		]);
		expect(groups.map((g) => g.category)).toEqual([
			"leadership",
			"speaker",
			"evaluator",
			"functionary",
		]);
	});

	// A "skeleton crew" club turns roles off (#368) and `getPublicClubRoles`
	// filters them out, so a whole category can legitimately be empty. It must
	// not render as a heading with nothing under it.
	it("drops empty categories entirely", () => {
		const groups = groupRolesByCategory([r("l", "leadership")]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.category).toBe("leadership");
	});

	it("returns nothing for an empty role list", () => {
		expect(groupRolesByCategory([])).toEqual([]);
	});

	// `listRoleDefinitions` already sorts by `sort_order`; the grouping must not
	// resort within a category or a club's chosen order is lost.
	it("preserves caller order within a category", () => {
		const groups = groupRolesByCategory([
			r("third", "functionary"),
			r("first", "functionary"),
			r("second", "functionary"),
		]);
		expect(groups[0]?.roles.map((x) => x.id)).toEqual([
			"third",
			"first",
			"second",
		]);
	});

	it("puts every role in exactly one group and loses none", () => {
		const roles = [
			r("a", "leadership"),
			r("b", "speaker"),
			r("c", "speaker"),
			r("d", "evaluator"),
			r("e", "functionary"),
		];
		const out = groupRolesByCategory(roles).flatMap((g) => g.roles);
		expect(out).toHaveLength(roles.length);
		expect(new Set(out.map((x) => x.id))).toEqual(
			new Set(roles.map((x) => x.id)),
		);
	});

	it("labels every category it can emit", () => {
		for (const c of CATEGORY_ORDER) {
			expect(CATEGORY_LABEL[c], `no label for ${c}`).toBeTruthy();
		}
	});
});

// `CATEGORY_ORDER` is typed `readonly RoleCategory[]`, and an ARRAY is not
// required to be exhaustive — so widening `roleCategoryEnum` and `RoleCategory`
// together, without touching `CATEGORY_ORDER`, compiles clean and makes
// `groupRolesByCategory` SILENTLY DROP every role in the new category, from the
// public roles guide and the printed sheet at once. (Four other files carry
// their own hand-written 4-value category union — `agenda.ts:70`,
// `meeting-roles.ts:146`, `role-template.ts:15`, `role-definitions-logic.ts:28`
// — so the typecheck failure a new value causes today comes from THEM, not from
// here. Update those and this module fails silently.)
//
// `src/db/schema.ts` imports only `drizzle-orm`, never `#/db`, so the enum is
// readable from a plain unit test with no DATABASE_URL.
describe("CATEGORY_ORDER exhaustiveness vs the DB enum", () => {
	it("covers roleCategoryEnum exactly — a new category cannot be silently dropped", () => {
		expect([...CATEGORY_ORDER].sort()).toEqual(
			[...roleCategoryEnum.enumValues].sort(),
		);
	});

	it("has a label for every value the DB can store", () => {
		for (const v of roleCategoryEnum.enumValues) {
			expect(CATEGORY_LABEL[v], `no label for ${v}`).toBeTruthy();
		}
	});

	it("groups a role of every DB category, losing none", () => {
		const roles = roleCategoryEnum.enumValues.map((c) => r(c, c));
		const grouped = groupRolesByCategory(roles).flatMap((g) => g.roles);
		expect(grouped).toHaveLength(roles.length);
	});
});

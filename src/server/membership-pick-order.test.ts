/**
 * The shared membership-pick order (#838), pinned as the SQL it renders.
 *
 * The integration suites (`meeting-authz-membership-pick`, `pathways-membership
 * -pick`) prove what the order DOES against real rows; this pins what it IS —
 * every key, its direction and its position — without a database, so a change
 * to the order is one named red test here even on a run with no
 * `TEST_DATABASE_URL`, where those suites skip.
 */
import { resolve } from "node:path";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { members, officerTerms } from "#/db/schema";
import { readSource } from "#/test/guard-source";
import {
	membershipPickOpenTermJoin,
	membershipPickOrder,
} from "./membership-pick-order";

function render() {
	return new QueryBuilder()
		.select({ id: members.id })
		.from(members)
		.leftJoin(officerTerms, membershipPickOpenTermJoin())
		.groupBy(members.id)
		.orderBy(...membershipPickOrder())
		.limit(1)
		.toSQL().sql;
}

describe("membershipPickOrder (#838)", () => {
	it("renders the five keys, in order, with their directions", () => {
		const sql = render();
		const orderBy = sql.slice(sql.indexOf(" order by ") + " order by ".length);
		expect(orderBy).toBe(
			[
				`("members"."status" = 'active') desc`,
				`("members"."club_role" = 'admin') desc`,
				`count("officer_terms"."id") desc`,
				// Ascending, with Postgres' default NULLS LAST — no explicit
				// direction, exactly as every copy before #838 spelled it.
				`"members"."created_at"`,
				`"members"."id" limit $1`,
			].join(", "),
		);
	});

	it("counts OPEN officer terms of THIS membership only", () => {
		expect(render()).toContain(
			`left join "officer_terms" on ("officer_terms"."membership_id" = "members"."id" and "officer_terms"."term_end" is null)`,
		);
	});

	it("hands each query its own fragments", () => {
		// Functions, not shared constants: two builders must not hold one object.
		const [a] = membershipPickOrder();
		const [b] = membershipPickOrder();
		expect(a).not.toBe(b);
		expect(membershipPickOpenTermJoin()).not.toBe(membershipPickOpenTermJoin());
	});

	it("imports nothing that reaches a database, auth or request context", () => {
		// `project-picker-logic.ts` imports this and must stay importable by
		// suites that mock only `#/db` (its docblock says why), so the import set
		// is the contract — pinned exactly, so a new import is a decision.
		const src = readSource(resolve(__dirname, "membership-pick-order.ts"));
		const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(specifiers.sort()).toEqual([
			"#/db/schema",
			"drizzle-orm",
			"drizzle-orm/pg-core",
		]);
	});
});

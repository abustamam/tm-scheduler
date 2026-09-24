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
import { SQL } from "drizzle-orm";
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
		const start = sql.indexOf(" order by ") + " order by ".length;
		const end = sql.indexOf(" limit ", start);
		// Both clauses must be present, or the slice below is not the ORDER BY.
		expect(start).toBeGreaterThan(" order by ".length - 1);
		expect(end).toBeGreaterThan(start);
		expect(sql.slice(start, end)).toBe(
			[
				`("members"."status" = 'active') desc`,
				`("members"."club_role" = 'admin') desc`,
				`count("officer_terms"."id") desc`,
				// Ascending, with Postgres' default NULLS LAST — no explicit
				// direction, exactly as every copy before #838 spelled it.
				`"members"."created_at"`,
				`"members"."id"`,
			].join(", "),
		);
	});

	it("counts OPEN officer terms of THIS membership only", () => {
		expect(render()).toContain(
			`left join "officer_terms" on ("officer_terms"."membership_id" = "members"."id" and "officer_terms"."term_end" is null)`,
		);
	});

	it("hands each query its own fragments", () => {
		// Functions, not shared constants: two builders must not hold one SQL
		// object. Checked per SQL KEY (the first three — the last two are table
		// columns, which every query shares by construction) and down to the
		// chunk array, so `return [...CONST]` over shared SQL constants, or a
		// fresh wrapper around one shared inner fragment, both fail here.
		const first = membershipPickOrder();
		const second = membershipPickOrder();
		for (const i of [0, 1, 2] as const) {
			expect(first[i]).toBeInstanceOf(SQL);
			expect(second[i]).not.toBe(first[i]);
			expect(second[i].queryChunks).not.toBe(first[i].queryChunks);
			// `desc(sql...)` nests the counted fragment one level down.
			for (const [j, chunk] of first[i].queryChunks.entries()) {
				if (chunk instanceof SQL) {
					expect(second[i].queryChunks[j]).not.toBe(chunk);
				}
			}
		}
		const joinA = membershipPickOpenTermJoin();
		const joinB = membershipPickOpenTermJoin();
		expect(joinB).not.toBe(joinA);
		expect(joinB.queryChunks).not.toBe(joinA.queryChunks);
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

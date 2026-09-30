/**
 * Who may edit a role's Before/During guide (#933): the admins who may edit
 * its `description`, through the same server fn, and nobody else.
 *
 * A source guard because a `createServerFn` handler cannot be invoked from
 * vitest. The guide fields ride `updateRoleSchema`, so the one writer is
 * `applyRoleDefinitionUpdate`, and the one caller of that is `updateClubRole`
 * — which must gate on `requireClubRole(…, ["admin"])` before it writes.
 */
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const FNS = readSource("src/server/role-definitions.ts");
const LOGIC = readSource("src/server/role-definitions-logic.ts");

describe("role guide authorization (#933)", () => {
	it("updateClubRole requires an admin before writing", () => {
		const body = serverFnBody(FNS, "updateClubRole");
		const gate = body.indexOf(
			'requireClubRole(currentUser.id, data.clubId, ["admin"])',
		);
		const write = body.indexOf("applyRoleDefinitionUpdate(data)");
		expect(gate).toBeGreaterThan(-1);
		expect(write).toBeGreaterThan(gate);
	});

	it("the guide fields are written only by applyRoleDefinitionUpdate", () => {
		const writers = [...LOGIC.matchAll(/guideNotesPatch\(/g)].length;
		// The declaration plus exactly one call.
		expect(writers).toBe(2);
		expect(LOGIC).toMatch(
			/export async function applyRoleDefinitionUpdate[\s\S]*?\.\.\.guideNotesPatch\(input\)/,
		);
		// Custom roles start blank: create takes no guide fields.
		const create = LOGIC.slice(
			LOGIC.indexOf("export const createRoleSchema"),
			LOGIC.indexOf("export type CreateRoleInput"),
		);
		expect(create.length).toBeGreaterThan(0);
		expect(create).not.toContain("beforeNotes");
		expect(create).not.toContain("duringNotes");
	});
});

/**
 * Who may read and edit a club's charter dashboard (#943), pinned at the
 * server fns.
 *
 * The rule: ADMINS only, both ways. Reads go through `requireClubAdminView`
 * (the dashboard names outside helpers' email and phone, so a plain member
 * reads none of it); every write goes through `requireClubRole(…, ["admin"])`,
 * which also admits open officers. The logic layer (`charter-logic.ts`) has no
 * session and trusts its caller, so the gate in each handler is the only thing
 * between any signed-in person and those rows — and a handler body is
 * unreachable from vitest. The gate functions themselves are exercised against
 * real rows in `charter.integration.test.ts`; this pins that each fn calls the
 * right one BEFORE the logic, and that the module declares no fn this file
 * does not cover.
 *
 * Read COMMENT-BLIND (`readSource`): every "must be present" assertion here
 * would otherwise be satisfiable by a comment naming the pattern.
 */
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const CHARTER = readSource("src/server/charter.ts");

const ADMIN_WRITE =
	/requireClubRole\(\s*user\.id,\s*data\.clubId,\s*\["admin"\]\s*\)/;
const ADMIN_READ = /requireClubAdminView\(\s*user\.id,\s*data\.clubId\s*\)/;

/** Each server fn, its gate, and the logic call that must come after it. */
const FNS: { fn: string; gate: RegExp; logic: string }[] = [
	{
		fn: "getCharterDashboard",
		gate: ADMIN_READ,
		logic: "getCharterDashboardDb",
	},
	{ fn: "getCharterSummary", gate: ADMIN_READ, logic: "getCharterSummaryDb" },
	{
		fn: "updateCharterTarget",
		gate: ADMIN_WRITE,
		logic: "updateCharterTargetDb",
	},
	{ fn: "addCharterStep", gate: ADMIN_WRITE, logic: "addCharterStepDb" },
	{ fn: "renameCharterStep", gate: ADMIN_WRITE, logic: "renameCharterStepDb" },
	{
		fn: "setCharterStepDone",
		gate: ADMIN_WRITE,
		logic: "setCharterStepDoneDb",
	},
	{ fn: "removeCharterStep", gate: ADMIN_WRITE, logic: "removeCharterStepDb" },
	{
		fn: "reorderCharterSteps",
		gate: ADMIN_WRITE,
		logic: "reorderCharterStepsDb",
	},
	{ fn: "addCharterHelper", gate: ADMIN_WRITE, logic: "addCharterHelperDb" },
	{
		fn: "removeCharterHelper",
		gate: ADMIN_WRITE,
		logic: "removeCharterHelperDb",
	},
];

describe("charter dashboard server fns (#943)", () => {
	for (const { fn, gate, logic } of FNS) {
		it(`${fn} calls its admin gate before ${logic}`, () => {
			const body = serverFnBody(CHARTER, fn);
			expect(body.length, `${fn} body not found`).toBeGreaterThan(0);
			const gateAt = body.search(gate);
			const logicAt = body.indexOf(`${logic}(`);
			expect(gateAt, `${fn}: gate ${gate} missing`).toBeGreaterThanOrEqual(0);
			expect(logicAt, `${fn}: ${logic}( missing`).toBeGreaterThan(gateAt);
		});
	}

	it("every server fn the module declares is covered above", () => {
		const declared = [
			...CHARTER.matchAll(/export const (\w+) = createServerFn\(/g),
		].map((m) => m[1]);
		expect(declared.length).toBeGreaterThan(0);
		expect(declared.sort()).toEqual(FNS.map((f) => f.fn).sort());
	});

	it("reads use the ADMIN view gate, never the member-level one", () => {
		expect(CHARTER).not.toMatch(/requireClubViewAccess/);
	});
});

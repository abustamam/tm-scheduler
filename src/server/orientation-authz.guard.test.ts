/**
 * Who may read and write new-member orientation (#940), pinned at the server
 * fns.
 *
 * The rules:
 *  - `getMyOrientation`: member-level READ gate (`requireClubViewAccess`),
 *    answering from the gate's own membership (a read-only impersonator has
 *    none and gets null). A read gate never writes, and neither does the read.
 *  - `getMemberOrientation`: ADMIN view gate (`requireClubAdminView`).
 *  - `setMyBasecampSetup` / `dismissMyOrientation`: the member's OWN row. The
 *    handler passes the SESSION's user id to the logic, which resolves the
 *    caller's membership (`ownMembershipId` → `requireMembership`); the input
 *    schema is `.strict()` and names no member, so no request can point the
 *    write at another row. `orientation.integration.test.ts` exercises that
 *    resolution against real rows.
 *  - `startOrientation`: an admin write about another person,
 *    `requireClubRole(…, ["admin"])` BEFORE the logic.
 *
 * A `createServerFn` handler body is unreachable from vitest, so this reads
 * the source COMMENT-BLIND (`readSource`): every "must be present" assertion
 * here would otherwise be satisfiable by a comment naming the pattern. Also
 * holds that the module declares no fn this file does not cover.
 */
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const ORIENTATION = readSource("src/server/orientation.ts");
const LOGIC = readSource("src/server/orientation-logic.ts");

/**
 * One top-level function's body in the logic module, from its declaration to
 * the first column-0 closing brace after it. Both ends are asserted FOUND:
 * an unfound end (-1) would slice to EOF and let another function's text
 * satisfy the assertion.
 */
function logicFnBody(fn: string): string {
	const at = LOGIC.indexOf(`export async function ${fn}(`);
	expect(at, `${fn} missing`).toBeGreaterThanOrEqual(0);
	const end = LOGIC.indexOf("\n}\n", at);
	expect(end, `${fn}: end of body not found`).toBeGreaterThan(at);
	return LOGIC.slice(at, end);
}

const ADMIN_WRITE =
	/requireClubRole\(\s*user\.id,\s*data\.clubId,\s*\["admin"\]\s*\)/;
const ADMIN_READ = /requireClubAdminView\(\s*user\.id,\s*data\.clubId\s*\)/;
const MEMBER_READ = /requireClubViewAccess\(\s*user\.id,\s*data\.clubId\s*\)/;
/** The session's user id, spread AFTER the input so input cannot override it. */
const SELF = /\{\s*\.\.\.data,\s*userId:\s*user\.id\s*\}/;

const FNS: { fn: string; gate: RegExp; logic: string }[] = [
	{ fn: "getMyOrientation", gate: MEMBER_READ, logic: "getOrientationDb" },
	{
		fn: "getMemberOrientation",
		gate: ADMIN_READ,
		logic: "getMemberOrientationDb",
	},
	{ fn: "setMyBasecampSetup", gate: SELF, logic: "setMyBasecampSetupDb" },
	{ fn: "dismissMyOrientation", gate: SELF, logic: "dismissMyOrientationDb" },
	{ fn: "startOrientation", gate: ADMIN_WRITE, logic: "startOrientationDb" },
];

describe("orientation server fns (#940)", () => {
	for (const { fn, gate, logic } of FNS) {
		it(`${fn} applies ${gate} before or at ${logic}`, () => {
			const body = serverFnBody(ORIENTATION, fn);
			expect(body.length, `${fn} body not found`).toBeGreaterThan(0);
			expect(body).toMatch(/requireUser\(\)/);
			const gateAt = body.search(gate);
			const logicAt = body.indexOf(`${logic}(`);
			expect(gateAt, `${fn}: ${gate} missing`).toBeGreaterThanOrEqual(0);
			expect(logicAt, `${fn}: ${logic}( missing`).toBeGreaterThanOrEqual(0);
			// A gate call precedes the logic; the SELF pattern is the logic's own
			// argument, so it sits after the call's opening paren.
			if (gate === SELF) expect(gateAt).toBeGreaterThan(logicAt);
			else expect(logicAt).toBeGreaterThan(gateAt);
		});
	}

	it("the dashboard read answers from the gate's membership, never input", () => {
		const body = serverFnBody(ORIENTATION, "getMyOrientation");
		expect(body).toMatch(/getOrientationDb\(\s*access\.membership\.id\s*\)/);
		expect(body).toMatch(/if\s*\(\s*!access\.membership\s*\)\s*return null/);
	});

	it("every server fn the module declares is covered above", () => {
		const declared = [
			...ORIENTATION.matchAll(/export const (\w+) = createServerFn\(/g),
		].map((m) => m[1]);
		expect(declared.length).toBeGreaterThan(0);
		expect(declared.sort()).toEqual(FNS.map((f) => f.fn).sort());
	});

	it("the reads are GETs and the writes are POSTs", () => {
		for (const fn of ["getMyOrientation", "getMemberOrientation"]) {
			expect(ORIENTATION).toMatch(
				new RegExp(
					`export const ${fn} = createServerFn\\(\\{ method: "GET" \\}\\)`,
				),
			);
		}
		for (const fn of [
			"setMyBasecampSetup",
			"dismissMyOrientation",
			"startOrientation",
		]) {
			expect(ORIENTATION).toMatch(
				new RegExp(
					`export const ${fn} = createServerFn\\(\\{ method: "POST" \\}\\)`,
				),
			);
		}
	});

	it("the self-writes resolve their row through requireMembership and refuse a memberless actor", () => {
		const body = logicFnBody("ownMembershipId");
		expect(body).toMatch(/requireMembership\(\s*userId,\s*club\s*\)/);
		expect(body).toMatch(/membership\.id === null/);
		for (const fn of ["setMyBasecampSetup", "dismissMyOrientation"]) {
			expect(logicFnBody(fn)).toMatch(
				/ownMembershipId\(\s*input\.userId,\s*input\.clubId\s*\)/,
			);
		}
	});

	it("the self-write schemas are strict and name no member", () => {
		for (const name of ["setBasecampSetupSchema", "dismissOrientationSchema"]) {
			const at = LOGIC.indexOf(`export const ${name}`);
			expect(at, `${name} missing`).toBeGreaterThanOrEqual(0);
			const end = LOGIC.indexOf(";", at);
			expect(end, `${name}: end of declaration not found`).toBeGreaterThan(at);
			const decl = LOGIC.slice(at, end);
			expect(decl).toMatch(/\.strict\(\)/);
			expect(decl).not.toMatch(/memberId/);
		}
	});
});

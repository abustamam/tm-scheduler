/**
 * Who may touch the area hierarchy (#1116), pinned at the server fns.
 *
 * `areas-logic.ts` has no session and trusts its caller, and a
 * `createServerFn` handler body cannot be run by a source read, so the gate in
 * each handler is the only thing between any signed-in person and the writes
 * (and the club list, and the email lookup). `areas-authz.integration.test.ts`
 * calls every fn as a non-superadmin and sees the refusal; THIS pins the order
 * the refusal depends on, for every declaration, without a hand-written list
 * deciding which fns are covered: a fn added to `areas.ts` is swept the day it
 * is written.
 *
 * The rule, per fn: `requireUser` first, then `requireSuperadmin` on that
 * user's own id, and only then any `areas-logic` call. A gate that runs after
 * the call it protects is decoration.
 *
 * Read COMMENT-BLIND (`readSource`): every "must be present" assertion here
 * would otherwise be satisfiable by a comment naming the pattern.
 */
import { describe, expect, it } from "vitest";
import { readSource, serverFnDeclarations } from "#/test/guard-source";

const SOURCE = readSource("src/server/areas.ts");
const DECLARATIONS = serverFnDeclarations(SOURCE);

/** The issue's table, with each `/` row expanded into its fns. */
const EXPECTED_FNS = [
	"listConsoleAreas",
	"getConsoleArea",
	"createDistrict",
	"createDivision",
	"createArea",
	"renameDivision",
	"renameArea",
	"addAreaClub",
	"linkAreaClub",
	"removeAreaClub",
	"findUserForDirector",
	"assignAreaDirector",
	"endAreaDirectorTerm",
];

/**
 * The local names `areas.ts` imports from `./areas-logic`, aliases resolved,
 * zod schemas left out (a schema is not a call into the logic).
 */
function logicCallNames(source: string): string[] {
	const imported = /import\s*\{([^}]*)\}\s*from\s*"\.\/areas-logic"/.exec(
		source,
	)?.[1];
	if (!imported) {
		throw new Error(
			"areas.ts no longer imports from ./areas-logic. Re-point this guard rather than deleting it.",
		);
	}
	return imported
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => part.split(/\s+as\s+/).pop() as string)
		.filter((name) => !name.endsWith("Schema"));
}

const LOGIC_NAMES = logicCallNames(SOURCE);

describe("areas.ts server fns are superadmin-only (#1116)", () => {
	it("sweeps every declared fn, and the floor is the issue's table", () => {
		// The floor the per-fn cases need: a regex that stopped matching would
		// empty the sweep and every case after it, in the direction that ships an
		// ungated console fn.
		expect(DECLARATIONS.map((d) => d.name).sort()).toEqual(
			[...EXPECTED_FNS].sort(),
		);
		expect(LOGIC_NAMES.length).toBeGreaterThanOrEqual(EXPECTED_FNS.length);
	});

	for (const declaration of DECLARATIONS) {
		it(`${declaration.name} runs requireUser, then requireSuperadmin on that user, before any areas-logic call`, () => {
			const handlerAt = declaration.body.indexOf(".handler(");
			expect(handlerAt, "no .handler( in the declaration").toBeGreaterThan(-1);
			const handler = declaration.body.slice(handlerAt);

			const session = handler.indexOf(
				"const currentUser = await requireUser();",
			);
			const gate = handler.indexOf("await requireSuperadmin(currentUser.id);");
			expect(session, "requireUser() is gone").toBeGreaterThan(-1);
			expect(gate, "requireSuperadmin(currentUser.id) is gone").toBeGreaterThan(
				-1,
			);
			expect(session).toBeLessThan(gate);

			// Every call into the logic comes after the gate, and there is one.
			const calls = LOGIC_NAMES.map((name) => ({
				name,
				at: handler.search(new RegExp(`\\b${name}\\(`)),
			})).filter((call) => call.at !== -1);
			expect(
				calls.map((c) => c.name),
				"the handler calls no areas-logic function",
			).not.toHaveLength(0);
			for (const call of calls) {
				expect(
					call.at,
					`${call.name}( runs before requireSuperadmin`,
				).toBeGreaterThan(gate);
			}
		});
	}

	it("reaches the database only through areas-logic", () => {
		// No `#/db` import in the server-fn module: the logic is the only way in,
		// so the gate above is the only door.
		expect(SOURCE).not.toMatch(/from\s+"#\/db/);
	});
});

/**
 * Who may run the Easy-Speak import (#1051, #1492), pinned at the server fns.
 *
 * `history-import-logic.ts` has no session and trusts its caller, and a
 * `createServerFn` handler body cannot be run by a source read. This pins, for
 * every declaration in `history-import.ts` (no hand-written list decides which
 * are covered), that `requireUser` runs first, `requireHistoryImportRunner` runs on that
 * user's own id and the request's own `clubId` next, and only then any call into the logic.
 * `history-import-authz.integration.test.ts` proves the refusal itself.
 *
 * Read COMMENT-BLIND (`readSource`), as `areas-authz.guard.test.ts` does.
 */
import { describe, expect, it } from "vitest";
import { readSource, serverFnDeclarations } from "#/test/guard-source";

const SOURCE = readSource("src/server/history-import.ts");
const DECLARATIONS = serverFnDeclarations(SOURCE);

const EXPECTED_FNS = [
	"listEasySpeakImports",
	"uploadEasySpeakBundle",
	"previewEasySpeakImport",
	"applyEasySpeakImport",
	"importEasySpeakSpeechRequests",
	"importEasySpeakMentors",
];

/** The logic modules history-import.ts calls into; the mentor step has its own (#1053). */
const LOGIC_MODULES = ["history-import-logic", "mentor-import-logic"];

/** The local names imported from the logic modules, aliases resolved, schemas left out. */
function logicCallNames(source: string): string[] {
	return LOGIC_MODULES.flatMap((module) => {
		const imported = new RegExp(
			`import\\s*\\{([^}]*)\\}\\s*from\\s*"\\./${module}"`,
		).exec(source)?.[1];
		if (!imported) {
			throw new Error(
				`history-import.ts no longer imports from ./${module}. Re-point this guard rather than deleting it.`,
			);
		}
		return imported
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => part.split(/\s+as\s+/).pop() as string)
			.filter((name) => !name.endsWith("Schema"));
	});
}

const LOGIC_NAMES = logicCallNames(SOURCE);

/** The gate: that user's own id and the request's own club. Whitespace-tolerant (biome wraps it). */
const GATE =
	/await requireHistoryImportRunner\(\s*currentUser\.id,\s*data\.clubId,?\s*\)/;
/** Where the gate's call ENDS in a handler, or -1. */
function gateEnd(handler: string): number {
	const m = GATE.exec(handler);
	return m ? m.index + m[0].length : -1;
}

describe("history-import.ts server fns are superadmin-or-club-admin only (#1051, #1492)", () => {
	// protects=the sweep covers exactly the six server fns (no hand-written list
	// decides what is covered) and six logic names;
	// fails_when=a server fn is added or removed without this list moving;
	// no_claim=what any fn does.
	it("sweeps every declared fn", () => {
		expect(DECLARATIONS.map((d) => d.name).sort()).toEqual(
			[...EXPECTED_FNS].sort(),
		);
		expect(LOGIC_NAMES).toHaveLength(6);
	});

	for (const declaration of DECLARATIONS) {
		// protects=each server fn asks requireUser, then the history-import gate for
		// that user and the request's own club, before any logic call;
		// fails_when=the gate moves after a logic call, is dropped, or reads another
		// user or club;
		// no_claim=the refusal itself (the authz integration test).
		it(`${declaration.name} runs requireUser, then requireHistoryImportRunner on that user and club, before any logic call`, () => {
			const handlerAt = declaration.body.indexOf(".handler(");
			expect(handlerAt, "no .handler( in the declaration").toBeGreaterThan(-1);
			const handler = declaration.body.slice(handlerAt);

			const session = handler.indexOf(
				"const currentUser = await requireUser();",
			);
			const gate = gateEnd(handler);
			expect(session, "requireUser() is gone").toBeGreaterThan(-1);
			expect(
				gate,
				"requireHistoryImportRunner(currentUser.id, data.clubId) is gone",
			).toBeGreaterThan(-1);
			expect(session).toBeLessThan(gate);

			const calls = LOGIC_NAMES.map((name) => ({
				name,
				at: handler.search(new RegExp(`\\b${name}\\(`)),
			})).filter((call) => call.at !== -1);
			expect(
				calls.map((c) => c.name),
				"the handler calls no logic function",
			).not.toHaveLength(0);
			for (const call of calls) {
				expect(
					call.at,
					`${call.name}( runs before requireHistoryImportRunner`,
				).toBeGreaterThan(gate);
			}
		});
	}

	// protects=the four writing fns refuse a read-only impersonation after the gate
	// and before their logic call;
	// fails_when=assertNotReadOnlyImpersonation is dropped or moves after the write;
	// no_claim=the helper's own predicate (the test below).
	it.each([
		["uploadEasySpeakBundle", "storeEasySpeakBundleLogic"],
		["applyEasySpeakImport", "applyEasySpeakImportLogic"],
		["importEasySpeakSpeechRequests", "importSpeechRequestsLogic"],
		["importEasySpeakMentors", "importMentorPairsLogic"],
	])("%s checks for a read-only impersonation session before it writes (%s)", (name, logicCall) => {
		const declaration = DECLARATIONS.find((d) => d.name === name);
		const handler =
			declaration?.body.slice(declaration.body.indexOf(".handler(")) ?? "";
		const gate = gateEnd(handler);
		const check = handler.indexOf(
			"await assertNotReadOnlyImpersonation(currentUser.id);",
		);
		expect(check, "the read-only check is gone").toBeGreaterThan(-1);
		expect(check).toBeGreaterThan(gate);
		expect(check).toBeLessThan(
			handler.search(new RegExp(`\\b${logicCall}\\(`)),
		);
	});

	// protects=the club-binding override reaches the logic only through overrideFor,
	// which throws for anyone who is not a superadmin;
	// fails_when=a handler passes data.overrideClubBinding straight down, or the
	// helper loses its superadmin check;
	// no_claim=that overrideFor throws at runtime (the authz integration test).
	it("the club-binding override is passed down only through overrideFor, which refuses a non-superadmin", () => {
		for (const name of ["uploadEasySpeakBundle", "applyEasySpeakImport"]) {
			const declaration = DECLARATIONS.find((d) => d.name === name);
			expect(declaration?.body, name).toMatch(
				/overrideClubBinding:\s*overrideFor\(runner,\s*data\.overrideClubBinding\)/,
			);
		}
		const helper = /function overrideFor[\s\S]*?\n}\n/.exec(SOURCE)?.[0] ?? "";
		expect(helper).toContain(
			'requested === true && runner.kind !== "superadmin"',
		);
		expect(helper).toContain("throw new Error(");
	});

	// protects=the read-only check consults the caller's active impersonation and
	// refuses mode read_only;
	// fails_when=the lookup or the mode comparison is dropped;
	// no_claim=the refusal at runtime (the authz integration test).
	it("the read-only check refuses a read_only session and only that", () => {
		const helper =
			/async function assertNotReadOnlyImpersonation[\s\S]*?\n}\n/.exec(
				SOURCE,
			)?.[0];
		expect(helper, "the helper is gone").toBeDefined();
		expect(helper).toContain("getActiveImpersonationForUser(userId)");
		expect(helper).toContain('impersonation?.mode === "read_only"');
	});

	it("takes the upload and the decisions by POST: a GET would put them in the URL", () => {
		for (const name of [
			"uploadEasySpeakBundle",
			"previewEasySpeakImport",
			"applyEasySpeakImport",
			"importEasySpeakSpeechRequests",
			"importEasySpeakMentors",
		]) {
			expect(DECLARATIONS.find((d) => d.name === name)?.method, name).toBe(
				"POST",
			);
		}
	});

	it("reaches the database only through the logic modules", () => {
		expect(SOURCE).not.toMatch(/from\s+"#\/db/);
	});
});

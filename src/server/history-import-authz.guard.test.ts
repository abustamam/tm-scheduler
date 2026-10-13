/**
 * Who may run the Easy-Speak import (#1051), pinned at the server fns.
 *
 * `history-import-logic.ts` has no session and trusts its caller, and a
 * `createServerFn` handler body cannot be run by a source read. This pins, for
 * every declaration in `history-import.ts` (no hand-written list decides which
 * are covered), that `requireUser` runs first, `requireSuperadmin` runs on that
 * user's own id next, and only then any call into the logic.
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
];

/** The local names imported from `./history-import-logic`, aliases resolved, schemas left out. */
function logicCallNames(source: string): string[] {
	const imported =
		/import\s*\{([^}]*)\}\s*from\s*"\.\/history-import-logic"/.exec(
			source,
		)?.[1];
	if (!imported) {
		throw new Error(
			"history-import.ts no longer imports from ./history-import-logic. Re-point this guard rather than deleting it.",
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

describe("history-import.ts server fns are superadmin-only (#1051)", () => {
	it("sweeps every declared fn", () => {
		expect(DECLARATIONS.map((d) => d.name).sort()).toEqual(
			[...EXPECTED_FNS].sort(),
		);
		expect(LOGIC_NAMES).toHaveLength(5);
	});

	for (const declaration of DECLARATIONS) {
		it(`${declaration.name} runs requireUser, then requireSuperadmin on that user, before any logic call`, () => {
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

			const calls = LOGIC_NAMES.map((name) => ({
				name,
				at: handler.search(new RegExp(`\\b${name}\\(`)),
			})).filter((call) => call.at !== -1);
			expect(
				calls.map((c) => c.name),
				"the handler calls no history-import-logic function",
			).not.toHaveLength(0);
			for (const call of calls) {
				expect(
					call.at,
					`${call.name}( runs before requireSuperadmin`,
				).toBeGreaterThan(gate);
			}
		});
	}

	it.each([
		["uploadEasySpeakBundle", "storeEasySpeakBundleLogic"],
		["applyEasySpeakImport", "applyEasySpeakImportLogic"],
		["importEasySpeakSpeechRequests", "importSpeechRequestsLogic"],
	])("%s checks for a read-only impersonation session before it writes (%s)", (name, logicCall) => {
		const declaration = DECLARATIONS.find((d) => d.name === name);
		const handler =
			declaration?.body.slice(declaration.body.indexOf(".handler(")) ?? "";
		const gate = handler.indexOf("await requireSuperadmin(currentUser.id);");
		const check = handler.indexOf(
			"await assertNotReadOnlyImpersonation(currentUser.id);",
		);
		expect(check, "the read-only check is gone").toBeGreaterThan(-1);
		expect(check).toBeGreaterThan(gate);
		expect(check).toBeLessThan(
			handler.search(new RegExp(`\\b${logicCall}\\(`)),
		);
	});

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
		]) {
			expect(DECLARATIONS.find((d) => d.name === name)?.method, name).toBe(
				"POST",
			);
		}
	});

	it("reaches the database only through history-import-logic", () => {
		expect(SOURCE).not.toMatch(/from\s+"#\/db/);
	});
});

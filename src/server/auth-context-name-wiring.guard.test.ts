/**
 * Source guard: `getAuthContext` must resolve the session display name off the
 * roster, and must prefer it over Better-Auth's `user.name` (#707).
 *
 * ## Why a source guard
 *
 * `auth-context-person-logic.integration.test.ts` proves the seam returns the
 * right name. It cannot prove `getAuthContext` still CALLS it, and the handler
 * body of a `createServerFn` is unreachable from vitest — CLAUDE.md lists that
 * as its own coverage trap, and it is exactly why the bug survived a ~6,000
 * test suite in the first place. Same shape, same answer, as the sibling
 * `auth-context-wiring.guard.test.ts` for the #560 archive filter.
 *
 * ## The two ways this reverts, both silent
 *
 * 1. **Dropping the call.** `name: user.name` type-checks, renders, and greets
 *    every production user by their raw email again. `user.name` is `""` for
 *    every magic-link account (`name: name || ""`, and nothing in `src/` ever
 *    writes it), so the `|| user.email` arm at the four consumers is the branch
 *    100% of real users take. Only `db/seed.ts` and `#/test/db` write a
 *    non-empty `user.name`, which is why dev and the whole suite look fine.
 * 2. **Flipping the operands** to `user.name ?? personName`. `??` only falls
 *    through on null/undefined, and `""` is neither — so that reinstates the
 *    bug for everyone while both the seam's suite and the greeting component's
 *    suite stay green. This is the reason the assertion pins the expression
 *    whole rather than checking that both names merely appear.
 *
 * ## Reading strategy
 *
 * Comment-blind throughout (`readSource`), including the "must NOT" arm. The
 * default in `guard-source.ts` is to read an offender list RAW, because there a
 * comment can only cause a false FAILURE — but `auth-context.ts` documents the
 * reversed operands in a comment, verbatim, to explain why they are wrong. Read
 * raw, the negative assertion would fail on the very comment that documents it.
 * `dashboard-hydration-wiring.guard.test.ts` resolved the same collision the
 * same way.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource(resolve(process.cwd(), "src/server/auth-context.ts"));
const SEAM = readSource(
	resolve(process.cwd(), "src/server/auth-context-person-logic.ts"),
);

describe("getAuthContext greets by the roster name (#707)", () => {
	it("resolves the display name through loadPersonDisplayName", () => {
		expect(SOURCE).toContain("loadPersonDisplayName(user.id)");
		expect(SOURCE).toContain('from "./auth-context-person-logic"');
	});

	it("returns the roster name in preference to the Better-Auth column", () => {
		expect(SOURCE).toContain("name: personName ?? user.name");
	});

	it("does not hand back the Better-Auth name bare", () => {
		// The pre-#707 shape, and the shape a "simplify this" pass reaches for.
		expect(SOURCE).not.toMatch(/name:\s*user\.name\s*,/);
		// The operand flip, which is falsy-vs-nullish and looks identical.
		expect(SOURCE).not.toMatch(/user\.name\s*\?\?\s*personName/);
	});

	it("the seam it calls actually reads the roster", () => {
		// Vacuity: the assertions above are satisfied by a seam that returns null
		// for everyone, which is the pre-fix behaviour with extra steps. Pin what
		// it reads at its definition; the behavioural proof is the integration
		// suite beside it.
		expect(SEAM).toContain("people.name");
		// Resolved through the shared canonical-Person resolver, NOT an ad-hoc
		// `where(eq(people.userId, …))`. `people.user_id` is not unique, so an
		// unordered pick of its own would name a different Person than Pathways,
		// progress marks and the project picker resolve to — #329/#437's bug
		// re-opened on the greeting.
		expect(SEAM).toContain("resolveUserPersonId(userId)");
		expect(SEAM).not.toMatch(/eq\(people\.userId,/);
	});
});

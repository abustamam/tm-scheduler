/**
 * Source guard: `getAuthContext` must resolve the session display name off the
 * roster, for the ACTIVE club, and must prefer it over Better-Auth's
 * `user.name` (#707).
 *
 * ## Why a source guard
 *
 * `auth-context-person-logic.integration.test.ts` proves the seam returns the
 * right name. It cannot prove `getAuthContext` still CALLS it, nor that it
 * passes the active club, and the handler body of a `createServerFn` is
 * unreachable from vitest — CLAUDE.md lists that as its own coverage trap, and
 * it is exactly why the bug survived a ~6,000 test suite in the first place.
 * Same shape, same answer, as the sibling `auth-context-wiring.guard.test.ts`
 * for the #560 archive filter.
 *
 * ## Mutation-checked (CODING_STANDARDS.md, "Test coverage")
 *
 * A source guard has no other way to prove it can fail at all, so every defect
 * below was reintroduced and the failing assertions counted before this was
 * committed:
 *
 * | mutation                                   | fails |
 * |--------------------------------------------|-------|
 * | `name: user.name` (drop the call)          | 2     |
 * | `user.name ?? personName` (operand flip)   | 2     |
 * | drop the `activeClubId` argument           | 1     |
 * | drop the `.catch`                          | 2     |
 * | rung 2 → an ad-hoc pick, not the resolver  | 1     |
 * | drop the seam's `orderBy`                  | 1     |
 *
 * One blind spot, recorded rather than papered over: gutting rung 1 to
 * `if (false)` while leaving its SQL in place passes every assertion here,
 * because a source grep cannot see a dead branch. The integration suite's
 * "greets by the ACTIVE club's spelling" catches that one, and the two tie
 * tests catch a dropped `orderBy` behaviourally as well — the division of
 * labour is deliberate, not an oversight.
 *
 * ## The ways this reverts, all silent
 *
 * 1. **Dropping the call.** `name: user.name` type-checks, renders, and greets
 *    every production user by their raw email again. `user.name` is `""` for
 *    every magic-link account (`name: name || ""`, and nothing in `src/` ever
 *    writes it), so the `|| user.email` arm at the seven consumers is the
 *    branch 100% of real users take. Only `db/seed.ts` and `#/test/db` write a
 *    non-empty `user.name`, which is why dev and the whole suite look fine.
 * 2. **Flipping the operands** to `user.name ?? personName`. `??` only falls
 *    through on null/undefined, and `""` is neither — so that reinstates the
 *    bug for everyone while both the seam's suite and the greeting component's
 *    suite stay green. This is why the assertion pins the expression whole
 *    rather than checking that both names merely appear.
 * 3. **Dropping `activeClubId`**, or moving the call back above the line that
 *    computes it. The seam still returns a name, so nothing goes blank and no
 *    behavioural test can see it — but a human duplicated across clubs with a
 *    different roster spelling in each stops being greeted by the club they are
 *    looking at, which is the edge case #707 names.
 * 4. **Dropping the `.catch`.** A name is cosmetic and a page is not; without
 *    it a failed lookup takes the authed page down with it.
 *
 * ## Reading strategy
 *
 * Comment-blind throughout (`readSource`), including the "must NOT" arm. The
 * default in `guard-source.ts` is to read an offender list RAW, because there a
 * comment can only cause a false FAILURE — but `auth-context.ts` documents the
 * reversed operands in a comment, verbatim, to explain why they are wrong. Read
 * raw, the negative assertion would fail on the very comment that documents it.
 * `dashboard-hydration-wiring.guard.test.ts` resolved the same collision the
 * same way. (`guard-source.ts:26-29` names two files as the exceptions; this is
 * now a third, and that doc block is stale — that file is not this change's to
 * edit.)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HANDLER_PATH = resolve(process.cwd(), "src/server/auth-context.ts");
const SOURCE = readSource(HANDLER_PATH);
const RAW = readFileSync(HANDLER_PATH, "utf8");
const SEAM = readSource(
	resolve(process.cwd(), "src/server/auth-context-person-logic.ts"),
);

describe("getAuthContext greets by the roster name (#707)", () => {
	it("resolves the display name through loadPersonDisplayName", () => {
		expect(SOURCE).toContain("loadPersonDisplayName(user.id");
		expect(SOURCE).toContain('from "./auth-context-person-logic"');
	});

	it("passes the ACTIVE club, and does so after that club is resolved", () => {
		expect(SOURCE).toContain(
			"loadPersonDisplayName(user.id, activeClubId).catch(() => null)",
		);
		// Ordering, not just presence: `activeClubId` is a `const` in the same
		// scope, so calling the seam above its declaration is a TDZ throw at
		// runtime rather than a type error — and this handler's throws surface as
		// a blank authed page. Anchored on the declaration itself so a comment
		// mentioning `activeClubId` earlier cannot move the offset (comments are
		// blanked here anyway; this keeps it true if that ever changes).
		const declared = SOURCE.indexOf("const activeClubId =");
		const used = SOURCE.indexOf("loadPersonDisplayName(user.id, activeClubId)");
		expect(declared).toBeGreaterThan(-1);
		expect(used).toBeGreaterThan(-1);
		expect(used).toBeGreaterThan(declared);
	});

	it("cannot let a cosmetic lookup fail the page", () => {
		// Every other query in this handler is load-bearing. This one decides
		// whether the header greets you by name or by email.
		expect(SOURCE).toMatch(
			/loadPersonDisplayName\([^)]*\)\.catch\(\(\) => null\)/,
		);
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

	it("the seam it calls actually reads the roster, both rungs", () => {
		// Vacuity: the assertions above are satisfied by a seam that returns null
		// for everyone, which is the pre-fix behaviour with extra steps. Pin what
		// it reads at its definition; the behavioural proof is the integration
		// suite beside it.
		expect(SEAM).toContain("people.name");
		// Rung 1 — the active club's roster row.
		expect(SEAM).toContain("eq(members.clubId, activeClubId)");
		// Rung 2 — the SHARED canonical-Person resolver, not an ad-hoc
		// `where(eq(people.userId, …))` of its own. `people.user_id` is not
		// unique, so an unordered pick would name a different Person than
		// `pathwaysForUser` (pathways-read-logic.ts), `selfPersonId`
		// (path-enrollment-logic.ts) and `selfPersonId` (progress-marks-logic.ts)
		// resolve to — #329/#437's divergence re-opened on the greeting.
		expect(SEAM).toContain("resolveUserPersonId(userId)");
	});

	it("the seam does not grow a second ordering of its own", () => {
		// Offender list, so read RAW — a comment here can only ever add a false
		// offender, and the seam's own docblock quotes the shape it avoids.
		const seamRaw = readFileSync(
			resolve(process.cwd(), "src/server/auth-context-person-logic.ts"),
			"utf8",
		);
		// The rung-1 tiebreak is `people.createdAt, people.id` — the same tail
		// `resolveUserPersonId` ends on, deliberately, so the two can never order
		// a tie differently. Anything richer is a second ordering to keep in step
		// by hand.
		expect(seamRaw.match(/\.orderBy\(/g) ?? []).toHaveLength(1);
		expect(SEAM).toContain("orderBy(people.createdAt, people.id)");
	});

	it("keeps the name off the impersonation path", () => {
		// `getSessionUser` never swaps `user.id`, so the context's id/email stay
		// the real superadmin's and the name must too. Pinned as the ARGUMENT:
		// passing an impersonated user id here would be the leak.
		expect(RAW).not.toMatch(/loadPersonDisplayName\(\s*impersonat/i);
		expect(SOURCE).toContain("loadPersonDisplayName(user.id,");
	});
});

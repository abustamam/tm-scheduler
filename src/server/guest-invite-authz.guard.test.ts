/**
 * The guest-invite WRITE is behind the gate (#899).
 *
 * `recordGuestInvite` is a `createServerFn`, which has no session and no RPC
 * layer under vitest, so its handler body is unreachable from a test
 * (`guest-edit-authz.integration.test.ts:10`). What `requireClubRole(…,
 * ["admin"])` does to a caller who does not qualify is proven elsewhere; this
 * pins that `recordGuestInvite` is the thing that calls it, in order, before
 * the logic runs — and that the actor it records is the RESOLVED membership,
 * never a value from the request. `recordGuestInviteSchema` is `.strict()` with
 * no actor field (`guest-pipeline-schemas.test.ts`), so the two halves together
 * say the inviter cannot be forged.
 *
 * `requireClubRole(…, ["admin"])` is the rule "a stored club admin, or a member
 * with an open officer term"; `requireMembership` inside it rejects an archived
 * club.
 *
 * Read comment-blind (`src/test/guard-source.ts`): the module documents its
 * gating in prose above each handler, so a raw read would keep passing after
 * the real call was deleted.
 */
// ## Mutation evidence (2026-09-26, run in this worktree via `bun run mutate`)
//
//   `requireClubRole(…, ["admin"])` widened to `["admin", "member"]` .... FAILS
//   `actorMemberId: membership.id` → `actorMemberId: null` .............. FAILS
//   a logic call inserted ABOVE `requireUser()` (write before gate) ..... FAILS
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const FILE = resolve(__dirname, "guest-pipeline.ts");
const SRC = readSource(FILE);

/** One `export const <name> = createServerFn…` declaration, so the assertion
 *  cannot be satisfied by a neighbour's byte-identical gate. */
function handlerBody(source: string, name: string): string {
	const start = source.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(
			`${name} not found in guest-pipeline.ts — it was renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = source.indexOf("\nexport const", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

describe("guest-invite authz wiring (#899)", () => {
	it("recordGuestInvite resolves the session, then the admin role, then writes", () => {
		const body = handlerBody(SRC, "recordGuestInvite");
		const user = body.indexOf("await requireUser()");
		const role = body.search(
			/requireClubRole\(\s*currentUser\.id,\s*data\.clubId,\s*\[\s*["']admin["'],?\s*\]\s*,?\s*\)/,
		);
		const write = body.indexOf("applyRecordGuestInvite(");
		expect(user, "requireUser() is missing").toBeGreaterThan(-1);
		expect(role, 'requireClubRole(…, ["admin"]) is missing').toBeGreaterThan(
			-1,
		);
		expect(write, "the logic call is missing").toBeGreaterThan(-1);
		expect(user).toBeLessThan(role);
		expect(role).toBeLessThan(write);
	});

	it("records the resolved membership as the actor, never request input", () => {
		const body = handlerBody(SRC, "recordGuestInvite");
		expect(body).toMatch(
			/const membership = await requireClubRole\(\s*currentUser\.id/,
		);
		expect(body).toMatch(/actorMemberId:\s*membership\.id\b/);
		// The logic call names its fields rather than spreading `data`, so a field
		// added to the input could never ride into it.
		expect(body).not.toMatch(/applyRecordGuestInvite\(\s*data\s*\)/);
		expect(body).not.toMatch(/\.\.\.data\b/);
		expect(body).toContain("recordGuestInviteSchema.parse(input)");
	});
});

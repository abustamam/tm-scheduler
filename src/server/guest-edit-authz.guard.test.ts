/**
 * The guest-edit WRITE is still behind the gate (#727).
 *
 * `guest-edit-authz.integration.test.ts` beside this file proves what
 * `requireClubRole(…, ["admin"])` does to a caller who does not qualify. It
 * cannot prove that `updateGuest` is the thing that calls it: a
 * `createServerFn` has no session and no RPC layer under vitest, so the handler
 * body is unreachable (the reason `member-write-authz.guard.test.ts` exists).
 * Deleting the gate would leave that whole integration file green.
 *
 * This matters more since #727 than it did before. `updateGuest` used to be
 * reachable only from `/_authed/admin/vp-membership`, where the route's own
 * `beforeLoad` redirected a non-admin before the dialog could render; the same
 * write is now offered from the MEETING page, which is not under `_authed` at
 * all. The route gate was never the permission — but it was a second wall, and
 * it is gone on the new path.
 *
 * TWO readers, one per assertion class (`src/test/guard-source.ts`):
 *
 *  · "the gate must BE present" → comment-blind. This module documents its own
 *    gating in prose two lines above each handler, so a raw read would keep
 *    passing after the real call was deleted — a false PASS.
 *  · "the public front door must have NO gate" → verbatim. Stripping only
 *    deletes text, and the stripper is a lexer: a `//` inside a string blanks
 *    the rest of its line and could erase a real call.
 */
// ## Mutation evidence (2026-09-17, run in this worktree)
//
//   `requireClubRole(…, ["admin"])` deleted from updateGuest ........... FAILS
//   the same gate widened to `["admin", "member"]` ..................... FAILS
//
// Both were applied to `guest-pipeline.ts`, this file run, and reverted.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const FILE = resolve(__dirname, "guest-pipeline.ts");
/** Comment-blind — for "the gate must BE present" only. */
const SRC = readSource(FILE);
/** Verbatim — for the one "must be ABSENT" assertion below. Stripping only
 *  deletes text and the stripper is a lexer, so a `//` inside a string blanks
 *  the rest of its line and could erase a real offending call
 *  (`src/test/guard-source.ts`). */
const RAW = readFileSync(FILE, "utf8");

/** One `export const <name> = createServerFn…` declaration, so a per-handler
 *  assertion cannot be satisfied by a neighbour's correct code — `setGuestStage`
 *  and `deleteGuest` carry a byte-identical gate a few lines away. */
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

describe("guest-edit authz wiring (#727)", () => {
	it("updateGuest resolves a real session before anything else", () => {
		// `requireClubRole` takes a user id; without `requireUser()` there is no id
		// to give it, and the meeting page's caller may hold nothing but a
		// localStorage roster pick.
		expect(handlerBody(SRC, "updateGuest")).toContain("await requireUser()");
	});

	it("updateGuest re-checks the club role on every call", () => {
		// Whitespace-tolerant: the formatter wraps this call across lines on the
		// sibling handlers, so pinning the exact one-line form would make this
		// guard fail on a reformat rather than on a missing gate.
		expect(handlerBody(SRC, "updateGuest")).toMatch(
			/requireClubRole\(\s*currentUser\.id,\s*data\.clubId,\s*\[\s*["']admin["'],?\s*\]/,
		);
	});

	it("slices ONE handler, so the two assertions above are about updateGuest", () => {
		// The fixture for the splitter, not a claim about the product. Every other
		// admin write in this module carries a byte-identical gate, so a splitter
		// that swept the whole file — or ran past the next declaration — would make
		// both assertions above pass with `updateGuest`'s own gate deleted.
		//
		// `submitGuestBook` is the honest control: it is the PUBLIC guest-book
		// front door (#239) and is deliberately ungated, so its body is the one
		// place in this module where a `requireClubRole` must not appear. Read
		// RAW, because this is the file's only "must be ABSENT" assertion.
		expect(handlerBody(RAW, "submitGuestBook")).not.toMatch(
			/await requireClubRole\(/,
		);
		// …and the slice is a real one, not an empty string that would satisfy any
		// absence.
		expect(handlerBody(RAW, "submitGuestBook")).toContain("captureGuestVisit");
	});
});

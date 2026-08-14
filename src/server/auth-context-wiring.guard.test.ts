/**
 * Source guard: `getAuthContext` must resolve the club switcher through the
 * archive-filtered seam (#560).
 *
 * `auth-context-clubs.integration.test.ts` proves `loadUserClubMemberships` filters
 * archived clubs. It cannot prove `getAuthContext` still CALLS it — that suite
 * imports the seam directly, so re-inlining the select (which is literally where
 * this query lived until #560) reintroduces the leak with every test green. The
 * observable is the CALL, and the handler body is unreachable from vitest: CLAUDE.md
 * lists this as its own coverage trap, and the extraction is what created the seam
 * this guard now has to hold.
 *
 * What the leak was: an archived club's NAME and Toastmasters club number in every
 * member's SSR payload, a switcher entry the `/club/$clubId` shell 404s on, and —
 * because `activeClubId` derives from the same list — an archived club eligible to
 * trigger `ensureScheduleToppedUp`, a read-triggered WRITE materializing meetings
 * into a club that had been taken down.
 *
 * Two directions, two reading strategies (see `guard-source.ts`):
 *  - "must call the seam" is must-BE-present, read comment-blind, so a comment
 *    naming the function cannot satisfy it with the real call deleted.
 *  - "must not inline a membership select" is offenders-must-be-EMPTY, read RAW,
 *    because stripping comments there could only ever LOOSEN it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const PATH = resolve(process.cwd(), "src/server/auth-context.ts");
const SOURCE = readSource(PATH);
const RAW = readFileSync(PATH, "utf8");

describe("getAuthContext club list is archive-filtered (#560)", () => {
	it("resolves memberships through loadUserClubMemberships", () => {
		expect(SOURCE).toContain("loadUserClubMemberships(user.id)");
		expect(SOURCE).toContain('from "./auth-context-logic"');
	});

	it("does not inline a membership select of its own", () => {
		// The pre-#560 shape: `.from(members).innerJoin(people…).innerJoin(clubs…)`
		// with no `isNull(clubs.archivedAt)`. Any re-inlining reintroduces it.
		expect(RAW).not.toMatch(/\.from\(members\)/);
		expect(RAW).not.toMatch(/eq\(members\.status,/);
	});

	it("the seam it calls actually carries the filter", () => {
		// Vacuity: the two assertions above are satisfied by a seam that filters
		// nothing, so pin the filter at its definition too. The behavioural proof
		// lives in auth-context-clubs.integration.test.ts; this keeps the guard from
		// passing on a gutted seam.
		const seam = readSource(
			resolve(process.cwd(), "src/server/auth-context-logic.ts"),
		);
		expect(seam).toContain("isNull(clubs.archivedAt)");
	});

	it("leaves the impersonation arm unfiltered, deliberately", () => {
		// A superadmin's session must still resolve a club to act in, and the
		// takedown is enforced at the gates rather than here. Pinned so a future
		// "consistency" pass does not quietly complete the sweep and blind the
		// console — the archived club is pushed in by id, with no archive predicate.
		expect(SOURCE).toContain("getActiveImpersonationForUser(user.id)");
		expect(SOURCE).toMatch(/myClubs\.push\(/);
	});
});

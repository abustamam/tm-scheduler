/**
 * Who may read a club's Area Director notice (#1118), pinned at the server fn.
 *
 * The rule: club ADMINS only, through `requireClubAdminView`, like the club
 * settings loaders. A non-admin member gets that gate's refusal and never
 * reaches the query. The logic layer (`club-area-notice-logic.ts`) has no
 * session and trusts its caller, so the gate in the handler is the only thing
 * between any signed-in person and the notice, and a handler body is
 * unreachable from vitest. The gate itself is exercised against real rows: an
 * admin's admission and an archived club's refusal in
 * `archive-club.integration.test.ts`, a plain member's refusal in
 * `orientation.integration.test.ts`. This pins that the fn calls it BEFORE the
 * logic, with the caller's own id and the club it was asked about.
 *
 * Read COMMENT-BLIND (`readSource`): every "must be present" assertion here
 * would otherwise be satisfiable by a comment naming the pattern, and this
 * module's own header names `requireClubAdminView` more than once.
 */
import { describe, expect, it } from "vitest";
import {
	readSource,
	serverFnBody,
	serverFnDeclarations,
} from "#/test/guard-source";

const SOURCE = readSource("src/server/club-area-notice.ts");

const ADMIN_READ = /requireClubAdminView\(\s*user\.id,\s*clubId\s*\)/;

describe("loadClubAreaNotice is admin-gated (#1118)", () => {
	const body = serverFnBody(SOURCE, "loadClubAreaNotice");

	it("resolves the caller and calls the admin view gate before the query", () => {
		const userAt = body.search(/requireUser\(\)/);
		const gateAt = body.search(ADMIN_READ);
		const logicAt = body.indexOf("loadClubAreaNoticeDb(");
		expect(userAt, "requireUser() missing").toBeGreaterThanOrEqual(0);
		expect(gateAt, `gate ${ADMIN_READ} missing`).toBeGreaterThan(userAt);
		expect(logicAt, "loadClubAreaNoticeDb( missing").toBeGreaterThan(gateAt);
	});

	it("is a GET and the only server fn in the module, and uses the ADMIN gate", () => {
		// The declared list is pinned so a second fn added to this module is
		// enrolled here rather than slipping in ungated, and the member-level gate
		// is refused outright: it would admit every active member. Declarations
		// come from `serverFnDeclarations`, which matches the declaration itself
		// and reads the method out of its body, so a fn is enrolled whatever its
		// key order, and one naming no method reports "UNKNOWN" instead of
		// dropping out of the list.
		const declared = serverFnDeclarations(SOURCE).map(
			(d) => `${d.name}:${d.method}`,
		);
		expect(declared).toEqual(["loadClubAreaNotice:GET"]);
		expect(SOURCE).not.toMatch(/requireClubViewAccess/);
	});
});

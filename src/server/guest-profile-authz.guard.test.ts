/**
 * The #1050 guest-profile server fns are still behind their gates.
 *
 * `guest-profile.integration.test.ts` proves what `requireClubRole(…,
 * ["admin"])` does to a plain member. It cannot prove `updateGuestProfile` is
 * the thing that calls it: a `createServerFn` has no session under vitest, so
 * the handler body is unreachable. Deleting the gate would leave that file
 * green, so this pins it — comment-blind (`readSource`), because the module
 * documents its gating in prose above each handler and a raw read would keep
 * passing after the real call was deleted.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const SRC = readSource(resolve(__dirname, "guests.ts"));

describe("guest-profile authz wiring (#1050)", () => {
	it("updateGuestProfile resolves a session and requires the club admin role", () => {
		const body = serverFnBody(SRC, "updateGuestProfile");
		expect(body).toContain("await requireUser()");
		expect(body).toMatch(
			/requireClubRole\(\s*currentUser\.id,\s*data\.clubId,\s*\[\s*["']admin["'],?\s*\]\s*\)/,
		);
		// The write runs AFTER the gate, not beside it.
		expect(body.indexOf("requireClubRole(")).toBeLessThan(
			body.indexOf("applyUpdateGuestProfile("),
		);
	});

	it("updateGuestProfile is a POST", () => {
		expect(serverFnBody(SRC, "updateGuestProfile")).toMatch(/method:\s*"POST"/);
	});

	for (const name of ["getGuestProfile", "getGuestProfiles"]) {
		it(`${name} requires the admin view of the club it reads`, () => {
			const body = serverFnBody(SRC, name);
			expect(body).toContain("await requireUser()");
			expect(body).toMatch(/await requireClubAdminView\(\s*currentUser\.id,/);
		});
	}
});

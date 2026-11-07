/**
 * The guest invite template server fns are behind the right gate (#1547).
 *
 * `createServerFn` handlers are unreachable from vitest, so what the gates do to
 * a member is proven against the real database in
 * `guest-invite-template.integration.test.ts`; this pins that each handler in
 * `guest-invite-template.ts` CALLS its gate, in order, before the logic runs.
 * Read comment-blind (`#/test/guard-source`), like `promo-authz.guard.test.ts`.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SRC = readSource(resolve(__dirname, "guest-invite-template.ts"));

function handlerBody(name: string): string {
	const start = SRC.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(`${name} not found — re-point this guard.`);
	}
	const next = SRC.indexOf("\nexport const", start + 1);
	return SRC.slice(start, next === -1 ? SRC.length : next);
}

const ADMIN_WRITE =
	/await requireClubRole\(\s*currentUser\.id,\s*data\.clubId,\s*\[\s*"admin",?\s*\]\s*,?\s*\)/;
const ADMIN_READ =
	/await requireClubAdminView\(\s*currentUser\.id,\s*clubId\s*\)/;

function assertOrder(body: string, gate: RegExp, logic: string) {
	const user = body.indexOf("await requireUser()");
	const g = body.search(gate);
	const l = body.indexOf(logic);
	expect(user, "requireUser() is missing").toBeGreaterThan(-1);
	expect(g, "the role gate is missing").toBeGreaterThan(-1);
	expect(l, `${logic} is missing`).toBeGreaterThan(-1);
	expect(user).toBeLessThan(g);
	expect(g).toBeLessThan(l);
}

describe("guest invite template authz wiring (#1547)", () => {
	// protects=every write is gated to an effective admin before it runs;
	// fails_when=a gate is removed, weakened or moved after the write;
	// no_claim=what the gate admits (the integration test).
	it("updateGuestInviteTemplates: session, then ADMIN, then the write", () => {
		assertOrder(
			handlerBody("updateGuestInviteTemplates"),
			ADMIN_WRITE,
			"applyUpdateGuestInviteTemplates(",
		);
	});

	it("resetGuestInviteTemplate: session, then ADMIN, then the write", () => {
		assertOrder(
			handlerBody("resetGuestInviteTemplate"),
			ADMIN_WRITE,
			"applyResetGuestInviteTemplate(",
		);
	});

	it("getGuestInviteTemplates: session, then the admin view, then the read", () => {
		assertOrder(
			handlerBody("getGuestInviteTemplates"),
			ADMIN_READ,
			"loadGuestInviteTemplates(",
		);
	});

	it("no gate admits a plain member", () => {
		expect(SRC).not.toMatch(/"member"/);
		expect(SRC).not.toMatch(/requireClubViewAccess|requireMembership\(/);
	});
});

/**
 * The marketing-blast server fns are behind the right gate (#931).
 *
 * `createServerFn` handlers are unreachable from vitest, so what
 * `requireClubRole(…, ["admin"])` and `requireClubAdminView` do to a member is
 * proven against the real database in `promo-logic.integration.test.ts`; this
 * pins that each handler in `promo.ts` CALLS its gate, in order, before the
 * logic runs. The one public fn, `getPublicFlyer`, is archive-gated through
 * `loadPublicFlyer` and enrolled in `public-readers-archive-gate.guard.test.ts`.
 *
 * Read comment-blind (`#/test/guard-source`): the module documents its gates in
 * prose, which would satisfy a raw grep after the real call was deleted.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SRC = readSource(resolve(__dirname, "promo.ts"));

function handlerBody(name: string): string {
	const start = SRC.indexOf(`export const ${name} = createServerFn`);
	if (start === -1) {
		throw new Error(`${name} not found in promo.ts — re-point this guard.`);
	}
	const next = SRC.indexOf("\nexport const", start + 1);
	return SRC.slice(start, next === -1 ? SRC.length : next);
}

const ADMIN_WRITE =
	/await requireClubRole\(\s*currentUser\.id,\s*(data\.clubId|clubId),\s*\[\s*"admin",?\s*\]\s*,?\s*\)/;
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

describe("marketing-blast authz wiring (#931)", () => {
	it("updatePromoTemplate: session, then ADMIN, then the write", () => {
		assertOrder(
			handlerBody("updatePromoTemplate"),
			ADMIN_WRITE,
			"applyUpdatePromoTemplate(",
		);
	});

	it("resetPromoTemplate: session, then ADMIN, then the write", () => {
		assertOrder(
			handlerBody("resetPromoTemplate"),
			ADMIN_WRITE,
			"applyResetPromoTemplate(",
		);
	});

	it("getPromoTemplate: session, then the admin view, then the read", () => {
		assertOrder(
			handlerBody("getPromoTemplate"),
			ADMIN_READ,
			"loadPromoTemplate(",
		);
	});

	it("getPromoContext: session, then the admin view on the RESOLVED club, then the read", () => {
		assertOrder(
			handlerBody("getPromoContext"),
			ADMIN_READ,
			"loadPromoContext(",
		);
	});

	it("no gate admits a plain member", () => {
		expect(SRC).not.toMatch(/"member"/);
		expect(SRC).not.toMatch(/requireClubViewAccess|requireMembership\(/);
	});

	it("the public flyer reads only through the archive-gated seam", () => {
		const body = handlerBody("getPublicFlyer");
		expect(body).toContain("loadPublicFlyer(");
		expect(body).not.toMatch(/loadPromoContext|loadPromoTemplate/);
	});
});

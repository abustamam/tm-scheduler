import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// Structural authz guard (#530). Every VPE reporting fn returns roster-wide
// participation history — who is drifting away, who has never spoken — which is
// officer information. `getAttendanceLapse` is the sharpest of the three: it
// reports, for every active member, how many meetings in a row they have missed.
//
// A behavioral test is not possible here: a createServerFn handler cannot be
// invoked outside a request context in vitest, and the integration tests
// exercise `reporting-logic.ts` directly, bypassing the guards entirely. So this
// reads the REAL source and asserts the gate wiring is present on each handler,
// catching a silent weakening the integration tests would never see.
describe("VPE reporting fn authz gating (#530)", () => {
	// Comment-blind (see `#/test/guard-source`). "The gate must BE present" is
	// precisely the assertion shape a prose comment satisfies for free, and
	// reporting.ts documents its own gating in a header comment that names
	// `requireClubAdminView` — unstripped, deleting the real call would leave
	// this green.
	const src = readSource(resolve(__dirname, "reporting.ts"));

	function handlerBody(exportName: string): string {
		const start = src.indexOf(`export const ${exportName}`);
		if (start === -1) {
			throw new Error(`${exportName} not found in reporting.ts`);
		}
		const nextExport = src.indexOf("\nexport const", start + 1);
		return src.slice(start, nextExport === -1 ? src.length : nextExport);
	}

	for (const fn of [
		"getSpeakerRotation",
		"getOverdueMembers",
		"getAttendanceLapse",
	]) {
		it(`${fn} requires a signed-in user`, () => {
			expect(handlerBody(fn)).toMatch(/await\s+requireUser\(/);
		});

		it(`${fn} AWAITS the club-admin gate before loading anything`, () => {
			// Asserting the bare substring is not enough: dropping the `await`
			// leaves this green, typecheck clean and lint clean, while the handler
			// returns roster-wide attendance history before the gate can reject and
			// the rejection becomes an unhandled promise. The `await` IS the gate.
			const body = handlerBody(fn);
			expect(body).toMatch(/await\s+requireClubAdminView\(/);
			expect(body.indexOf("requireClubAdminView")).toBeLessThan(
				body.search(/return\s+load/),
			);
		});
	}

	it("exposes no reporting fn without an admin gate", () => {
		// Catches a FOURTH fn added later without a gate, which the per-name
		// assertions above cannot see.
		const exports = [
			...src.matchAll(/export const (\w+) = createServerFn/g),
		].map((m) => m[1]);
		expect(exports.length).toBeGreaterThanOrEqual(3);
		for (const name of exports) {
			expect(handlerBody(name)).toContain("requireClubAdminView(");
		}
	});
});

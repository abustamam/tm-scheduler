import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// Structural authz guard (#529). Action items are club business, so READS are
// open to any signed-in club member — but every WRITE must stay admin-gated,
// and nothing here may be reachable without a session.
//
// A behavioral test is not possible: a createServerFn handler cannot be invoked
// outside a request context in vitest, and the integration tests exercise
// `action-items-logic.ts` directly, bypassing these guards entirely. So this
// reads the REAL source and asserts the wiring, catching a silent weakening the
// integration suite would never surface.
describe("action-item fn authz gating (#529)", () => {
	// Comment-blind (see `#/test/guard-source`). "The gate must BE present" is
	// precisely the shape a prose comment satisfies for free, and this module
	// documents its own split in a header comment naming both guards.
	const src = readSource(resolve(__dirname, "action-items.ts"));

	function handlerBody(exportName: string): string {
		const start = src.indexOf(`export const ${exportName}`);
		if (start === -1) {
			throw new Error(`${exportName} not found in action-items.ts`);
		}
		const nextExport = src.indexOf("\nexport const", start + 1);
		return src.slice(start, nextExport === -1 ? src.length : nextExport);
	}

	const WRITES = [
		"addActionItem",
		"editActionItem",
		"closeActionItem",
		"restoreActionItem",
		"removeActionItem",
	];
	const READS = ["getActionItems", "getOpenActionItems"];

	for (const fn of WRITES) {
		it(`${fn} requires the admin club role`, () => {
			// Whitespace-tolerant: the formatter wraps the call across lines.
			expect(handlerBody(fn)).toMatch(
				/requireClubRole\([^)]*\[\s*["']admin["'],?\s*\]/,
			);
		});
	}

	for (const fn of READS) {
		it(`${fn} requires club view access`, () => {
			expect(handlerBody(fn)).toContain("requireClubViewAccess(");
		});
	}

	for (const fn of [...WRITES, ...READS]) {
		it(`${fn} requires a signed-in user`, () => {
			expect(handlerBody(fn)).toContain("requireUser(");
		});
	}

	it("never gates a write on the member role", () => {
		expect(src).not.toContain('["member"]');
	});

	it("leaves no exported fn ungated", () => {
		// Catches a fn added later that this file's explicit lists do not name.
		const exports = [
			...src.matchAll(/export const (\w+) = createServerFn/g),
		].map((m) => m[1]);
		expect(new Set(exports)).toEqual(new Set([...WRITES, ...READS]));
		for (const name of exports) {
			const body = handlerBody(name);
			expect(
				body.includes("requireClubRole(") ||
					body.includes("requireClubViewAccess("),
			).toBe(true);
		}
	});
});

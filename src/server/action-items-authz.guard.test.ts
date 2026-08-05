import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// Structural authz guard (#529). Action items are club business, so READS are
// open to any signed-in club member — but every WRITE must stay admin-gated,
// and nothing here may be reachable without a session.
//
// This is the STRUCTURAL half. A `createServerFn` handler cannot be invoked
// outside a request context in vitest, and the integration tests exercise
// `action-items-logic.ts` directly, bypassing these guards entirely — so this
// reads the REAL source and asserts the wiring. The behavioral half, which
// calls `requireClubRole` itself and proves a plain member is actually rejected,
// lives in `action-items.integration.test.ts`; neither one alone is enough.
//
// Every gate assertion below requires `await`. Without it the source still reads
// as gated, biome and tsc stay clean, and the handler runs to completion while
// the rejection surfaces as nothing but an unhandled promise — i.e. every write
// silently open to any signed-in member. That is the exact mutation this file
// exists to catch, so it is asserted rather than assumed.
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
		it(`${fn} AWAITS the admin club role`, () => {
			// Whitespace-tolerant: the formatter wraps the call across lines.
			// `await` is load-bearing — see the header.
			expect(handlerBody(fn)).toMatch(
				/await\s+requireClubRole\([^)]*\[\s*["']admin["'],?\s*\]/,
			);
		});
	}

	for (const fn of READS) {
		it(`${fn} AWAITS club view access`, () => {
			expect(handlerBody(fn)).toMatch(/await\s+requireClubViewAccess\(/);
		});
	}

	for (const fn of [...WRITES, ...READS]) {
		it(`${fn} AWAITS a signed-in user`, () => {
			expect(handlerBody(fn)).toMatch(/await\s+requireUser\(/);
		});
	}

	it("never gates a write on the member role", () => {
		// RAW source, not the comment-stripped copy. This is an "offender must be
		// ABSENT" assertion, and stripping can only LOOSEN one: comments are blanked
		// to spaces, so live code written as `["member" /* for now */]` would stop
		// containing the forbidden text and pass. The direction is the opposite of
		// the must-BE-present assertions above, which is why they read `src`.
		const raw = readFileSync(resolve(__dirname, "action-items.ts"), "utf8");
		expect(raw).not.toMatch(/requireClubRole\([^)]*\[\s*["']member["']/);
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
				/await\s+requireClubRole\(/.test(body) ||
					/await\s+requireClubViewAccess\(/.test(body),
			).toBe(true);
		}
	});
});

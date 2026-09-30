import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// Structural authz guard for `getOrientationRoster` (#942), in the shape of
// `reporting-authz.guard.test.ts`: a createServerFn handler cannot be invoked
// from vitest, and the integration suite calls `loadOrientationRoster`
// directly, so this reads the real source (comment-blind) and asserts the gate
// is awaited before anything loads. The rows carry every in-orientation
// member's progress and contact, which is officer information.
describe("getOrientationRoster authz gating (#942)", () => {
	const src = readSource(resolve(__dirname, "reporting.ts"));
	const start = src.indexOf("export const getOrientationRoster");
	const next = src.indexOf("\nexport const", start + 1);
	const body = src.slice(start, next === -1 ? src.length : next);

	it("exists", () => {
		expect(start).toBeGreaterThan(-1);
	});

	it("requires a signed-in user", () => {
		expect(body).toMatch(/await\s+requireUser\(/);
	});

	it("AWAITS the club-admin gate before loading anything", () => {
		expect(body).toMatch(
			/await\s+requireClubAdminView\(user\.id,\s*data\.clubId\)/,
		);
		expect(body.indexOf("requireClubAdminView")).toBeLessThan(
			body.search(/return\s+loadOrientationRoster\(data\.clubId\)/),
		);
	});
});

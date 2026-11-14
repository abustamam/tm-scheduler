/**
 * Both routes that build a templated deck must hand the builder the ballot URL
 * and the slots (#1635); both are optional on the builder, so a route that drops
 * one typechecks and quietly loses the vote slides' QR or nominees.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES = [
	"src/routes/club.$clubId.meeting.$meetingId.tsx",
	"src/routes/club.$clubId_.meeting.$meetingId.present.tsx",
];

describe("templated deck gets the ballot URL and slots", () => {
	for (const file of ROUTES) {
		it(file, () => {
			const call =
				readSource(file).match(
					/buildTemplateSlideDeck\(\{[\s\S]*?\n\t\t\t\}\)/,
				)?.[0] ?? "";
			expect(call).toMatch(/\bballotUrl,/);
			expect(call).toMatch(/\bslots(:\s*data\.slots)?,/);
		});
	}
});

/**
 * The public ballot payload must never carry PII (#510). The club sheet is a
 * SOFT gate and this route is fully public, so an email or phone on the payload
 * is a leak, not a display bug.
 *
 * "Offenders must be EMPTY" shape — it can only fail falsely, so the raw source
 * is fine here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LOGIC = readFileSync("src/server/voting-logic.ts", "utf8");
const CANDIDATES = readFileSync("src/server/award-candidates-logic.ts", "utf8");

describe("public voting payloads carry no PII (#510)", () => {
	it("neither module selects an email or phone column", () => {
		const offenders: string[] = [];
		for (const [file, src] of [
			["voting-logic.ts", LOGIC],
			["award-candidates-logic.ts", CANDIDATES],
		] as const) {
			for (const column of [
				"guests.email",
				"guests.phone",
				"people.email",
				"people.phone",
				"members.email",
			]) {
				if (src.includes(column)) offenders.push(`${file}: ${column}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

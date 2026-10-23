import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// protects=every exported write in areas-logic.ts refuses the demo district
// (#1279); a future write that forgets the refusal fails here, not in prod;
// fails_when=an exported async function with .insert(/.update(/.delete( in its
// body (other than createDistrict) lacks a refuseDemoDistrict( call, or
// createDistrict stops checking RESERVED_DEMO_NUMBER;
// no_claim=that the refusal sits on the right row (the integration suite).
const source = readFileSync(
	new URL("./areas-logic.ts", import.meta.url),
	"utf8",
);

/** Each exported async function's source, from its `export` to the next one. */
function exportedFunctions(): { name: string; body: string }[] {
	const starts = [...source.matchAll(/^export async function (\w+)/gm)];
	return starts.map((m, i) => ({
		name: m[1] as string,
		body: source.slice(m.index, starts[i + 1]?.index ?? source.length),
	}));
}

describe("areas-logic demo refusal", () => {
	const fns = exportedFunctions();
	const writers = fns.filter((f) => /\.(insert|update|delete)\(/.test(f.body));

	it("finds the writers (the scan itself is not vacuous)", () => {
		expect(writers.map((f) => f.name)).toEqual(
			expect.arrayContaining(["createDistrict", "renameArea", "addAreaClub"]),
		);
		expect(writers.length).toBeGreaterThanOrEqual(9);
	});

	it.each(
		writers
			.filter((f) => f.name !== "createDistrict")
			.map((f) => [f.name, f.body]),
	)("%s calls refuseDemoDistrict", (_name, body) => {
		// createDivision refuses through assertDistrictWritable (checked below).
		expect(body).toMatch(/refuseDemoDistrict\(|assertDistrictWritable\(/);
	});

	it("assertDistrictWritable itself refuses", () => {
		const helper = source.slice(
			source.indexOf("async function assertDistrictWritable"),
		);
		expect(helper.slice(0, helper.indexOf("\n}\n"))).toContain(
			"refuseDemoDistrict(",
		);
	});

	it("createDistrict checks the reserved number", () => {
		const fn = fns.find((f) => f.name === "createDistrict");
		expect(fn?.body).toContain("RESERVED_DEMO_NUMBER");
		expect(fn?.body).toContain("DEMO_DISTRICT_NUMBER_MESSAGE");
	});
});

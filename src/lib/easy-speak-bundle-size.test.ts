import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type EasySpeakBundleV1,
	easySpeakBundleV1Schema,
} from "./easy-speak-bundle";
import { MAX_BUNDLE_BYTES } from "./import-bundle-limit";

/**
 * #1235: the raw pages ride in their own archive file, so the bundle that is
 * uploaded stays far under the 50 MB cap however large the pages are. Reads the
 * extension's expected-bundle JSON as text; nothing under src/ imports extension/.
 */
const EXPECTED = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);

const load = (): EasySpeakBundleV1 =>
	JSON.parse(readFileSync(EXPECTED, "utf8"));

describe("the Easy-Speak upload bundle's size (#1235)", () => {
	it("the expected bundle parses with the schema and carries no raw pages", () => {
		const parsed = easySpeakBundleV1Schema.safeParse(load());
		expect(parsed.error?.issues ?? []).toEqual([]);
		expect(parsed.success).toBe(true);
		expect(load().raw).toEqual([]);
	});

	it("a club of 800 meetings with raw: [] fits MAX_BUNDLE_BYTES and parses", () => {
		const b = load();
		const meeting = b.meetings[0];
		const big: EasySpeakBundleV1 = {
			...b,
			meetings: Array.from({ length: 800 }, (_, i) => ({
				...meeting,
				esMeetingId: String(i),
			})),
			raw: [],
		};
		const bytes = Buffer.byteLength(JSON.stringify(big));
		console.log(
			`800-meeting upload bundle: ${bytes} bytes (cap ${MAX_BUNDLE_BYTES})`,
		);
		expect(bytes).toBeLessThan(MAX_BUNDLE_BYTES);
		expect(easySpeakBundleV1Schema.safeParse(big).success).toBe(true);
	});
});

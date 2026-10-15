import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { easySpeakBundleV1Schema } from "./easy-speak-bundle";
import { MAX_BUNDLE_BYTES } from "./import-bundle-limit";

/**
 * #1235: the export keeps its raw pages in a separate archive file, so the
 * upload bundle has `raw: []`. The schema keeps accepting `raw`, so a bundle
 * exported before the split still uploads. Plain JSON reads only: nothing under
 * `src/` imports from `extension/`.
 */
const expected = JSON.parse(
	readFileSync(
		resolve(
			__dirname,
			"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
		),
		"utf8",
	),
);

describe("the upload bundle without raw pages", () => {
	it("is what the export writes now, and parses with an empty raw", () => {
		expect(expected.raw).toEqual([]);
		expect(easySpeakBundleV1Schema.parse(expected).raw).toEqual([]);
	});

	it("an old bundle that still carries raw pages still parses", () => {
		const old = {
			...expected,
			raw: [
				{
					url: "https://easy-speak.org/view_meeting.php?t=1",
					fetchedAt: "2026-10-13T12:00:00.000Z",
					html: "<html></html>",
				},
			],
		};
		expect(easySpeakBundleV1Schema.parse(old).raw).toHaveLength(1);
	});

	it("an old bundle with a contact page in raw is still refused", () => {
		const bad = {
			...expected,
			raw: [
				{
					url: "https://easy-speak.org/memberlist.php",
					fetchedAt: "2026-10-13T12:00:00.000Z",
					html: "x",
				},
			],
		};
		expect(easySpeakBundleV1Schema.safeParse(bad).success).toBe(false);
	});

	it("a bundle of 771 meetings is far under the upload cap", () => {
		// Every array that grows with club history is scaled by the same factor.
		const factor = 771 / expected.meetings.length;
		const scaled = Object.fromEntries(
			Object.entries(expected).map(([key, value]) => {
				if (!Array.isArray(value) || value.length === 0) return [key, value];
				const length = Math.ceil(value.length * factor);
				return [key, Array.from({ length }, (_, i) => value[i % value.length])];
			}),
		);
		expect(scaled.meetings).toHaveLength(771);
		const bytes = Buffer.byteLength(JSON.stringify(scaled));
		// Absolute ceiling (12.5 MB), not a fraction of the constant it guards.
		expect(bytes).toBeLessThan(12.5 * 1024 * 1024);
		expect(bytes).toBeLessThan(MAX_BUNDLE_BYTES);
	});
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	BUNDLE_SCHEMAS,
	easySpeakStoredSchema,
	easySpeakUploadSchema,
} from "./easy-speak-bundle";
import {
	CURRENT_BUNDLE_VERSION,
	oversizeMessage,
	SNIFF_HEAD_BYTES,
	wrongVersionMessage,
} from "./easy-speak-bundle-version";
import versions from "./easy-speak-bundle-versions.json";
import { bundleTooBigMessage } from "./import-bundle-limit";

const SIXTY_MIB = 60 * 1024 * 1024;
const SIZE = bundleTooBigMessage(SIXTY_MIB);
const OLDER_N1 =
	"This file came from an older GavelUp extension (format 1). Install the latest and export again.";
const OLDER =
	"This file came from an older GavelUp extension. Install the latest and export again.";
const NEWER =
	"This file came from a newer GavelUp extension (format 3) than this site reads yet. Try again after the next GavelUp update.";
const ARCHIVE =
	"That is the pages archive (the file ending in -pages.json). Upload the other file the export saved.";
const head = (rest: string) =>
	`{"format":"gavelup.easy-speak-bundle",${rest}"exportedAt":"2026-01-01T00:00:00.000Z",`;

describe("wrongVersionMessage", () => {
	// protects=the admin's instruction on a refused upload; fails_when=a branch returns another branch's sentence; no_claim=wording beyond these exact strings
	it("names an older format", () => {
		expect(wrongVersionMessage(1)).toBe(OLDER_N1);
	});
	it("has an N-less sentence when the version is unknown", () => {
		expect(wrongVersionMessage(null)).toBe(OLDER);
	});
	it("says a newer extension is ahead of the site", () => {
		expect(wrongVersionMessage(3)).toBe(NEWER);
	});
});

describe("oversizeMessage", () => {
	// protects=the panel telling a stale-extension admin why a file is too big; fails_when=a head is classified into the wrong sentence; no_claim=files whose head exceeds 64 KiB before the format key
	it("adds the older-extension sentence for a v1 head", () => {
		expect(oversizeMessage(SIXTY_MIB, head('"version":1,'))).toBe(
			`${SIZE} ${OLDER_N1}`,
		);
	});
	it("tolerates whitespace after the colons", () => {
		const h =
			'{ "format" : "gavelup.easy-speak-bundle", "version" : 1, "exportedAt":"x",';
		expect(oversizeMessage(SIXTY_MIB, h)).toBe(`${SIZE} ${OLDER_N1}`);
	});
	it("adds the newer sentence for version 3", () => {
		expect(oversizeMessage(SIXTY_MIB, head('"version":3,'))).toBe(
			`${SIZE} ${NEWER}`,
		);
	});
	it("adds the N-less sentence when there is no version", () => {
		expect(oversizeMessage(SIXTY_MIB, head(""))).toBe(`${SIZE} ${OLDER}`);
	});
	it("treats a non-integer version as missing", () => {
		expect(oversizeMessage(SIXTY_MIB, head('"version":2.5,'))).toBe(
			`${SIZE} ${OLDER}`,
		);
		expect(oversizeMessage(SIXTY_MIB, head('"version":"2",'))).toBe(
			`${SIZE} ${OLDER}`,
		);
	});
	it("names the pages archive", () => {
		const h = '{"format":"gavelup.easy-speak-pages","version":1,';
		expect(oversizeMessage(SIXTY_MIB, h)).toBe(`${SIZE} ${ARCHIVE}`);
	});
	it("adds nothing for a current-version head without inline raw", () => {
		expect(oversizeMessage(SIXTY_MIB, head('"version":2,'))).toBe(SIZE);
	});
	it("calls a current-version head with inline raw an older extension", () => {
		const h = head('"version":2,') + '"raw":[ {"url":"https://x"';
		expect(oversizeMessage(SIXTY_MIB, h)).toBe(`${SIZE} ${OLDER}`);
	});
	it("reads a head of 65536 bytes", () => {
		expect(SNIFF_HEAD_BYTES).toBe(65536);
	});
	it("adds nothing for a head that is not a bundle", () => {
		expect(oversizeMessage(SIXTY_MIB, '{"hello":"world"}')).toBe(SIZE);
		expect(oversizeMessage(SIXTY_MIB, "")).toBe(SIZE);
	});
});

const record = versions as Record<
	string,
	{ extension: string; shape: unknown }
>;
const toShape = (schema: z.ZodType) =>
	JSON.parse(
		JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" })),
	);
const semver = (v: string): number[] => v.split(".").map(Number);
const cmp = (a: string, b: string): number => {
	const [x, y] = [semver(a), semver(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
};

describe("the shape record (easy-speak-bundle-versions.json)", () => {
	// protects=every format change bumping the version; fails_when=a shipped schema changes without a new version; no_claim=a .refine-only change (not in the JSON schema) or an edit to a shipped entry together with its schema: review checks
	const KEYS = Array.from({ length: CURRENT_BUNDLE_VERSION }, (_, i) =>
		String(i + 1),
	);

	it("has exactly one entry per version, 1 through the current one", () => {
		expect(Object.keys(record)).toEqual(KEYS);
	});

	it.each(KEYS)("version %s still has the shape that shipped", (n) => {
		const schema = BUNDLE_SCHEMAS[Number(n) as keyof typeof BUNDLE_SCHEMAS];
		expect(
			toShape(schema),
			"The bundle's shape changed. Bump CURRENT_BUNDLE_VERSION, add a new schema and a new entry here; never edit a shipped entry.",
		).toEqual(record[n].shape);
	});

	it("wires the upload and stored schemas to the same versions", () => {
		expect(easySpeakUploadSchema).toBe(
			BUNDLE_SCHEMAS[CURRENT_BUNDLE_VERSION as keyof typeof BUNDLE_SCHEMAS],
		);
		expect(easySpeakUploadSchema.shape.version.value).toBe(
			CURRENT_BUNDLE_VERSION,
		);
		expect(easySpeakStoredSchema.options).toHaveLength(KEYS.length);
	});

	it("bumps the extension's semver with each format, and package.json is at least the current one", () => {
		const exts = KEYS.map((k) => record[k].extension);
		for (let i = 1; i < exts.length; i++) {
			expect(cmp(exts[i - 1], exts[i])).toBeLessThan(0);
		}
		const pkg = JSON.parse(
			readFileSync(resolve(__dirname, "../../extension/package.json"), "utf8"),
		) as { version: string };
		expect(cmp(pkg.version, exts[exts.length - 1])).toBeGreaterThanOrEqual(0);
	});
});

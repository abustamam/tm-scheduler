import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	absoluteUrl,
	DEFAULT_SHARE_IMAGE,
	NOINDEX,
	shareMeta,
} from "#/lib/share-meta";

describe("absoluteUrl", () => {
	it("prefixes the production origin and leaves absolute URLs alone", () => {
		expect(absoluteUrl("/og/default.png")).toBe(
			"https://gavelup.app/og/default.png",
		);
		expect(absoluteUrl("tour")).toBe("https://gavelup.app/tour");
		expect(absoluteUrl("https://x.test/a.png")).toBe("https://x.test/a.png");
	});
});

// protects=every page without its own card previews a real 1200x630 file;
// fails_when=the default points at a deleted or mis-sized file under public/.
describe("DEFAULT_SHARE_IMAGE", () => {
	it("is a 1200x630 PNG under public/", () => {
		const png = readFileSync(`public${DEFAULT_SHARE_IMAGE}`);
		expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
		expect(png.readUInt32BE(16)).toBe(1200);
		expect(png.readUInt32BE(20)).toBe(630);
	});
});

describe("shareMeta", () => {
	const meta = shareMeta({
		title: "T",
		description: "D",
		path: "/club/x",
		extra: [NOINDEX],
	});
	const count = (k: "name" | "property", v: string) =>
		meta.filter((m) => m[k] === v).length;

	it("emits one of each share tag, with an absolute og:image and og:url", () => {
		for (const [k, v] of [
			["name", "description"],
			["property", "og:title"],
			["property", "og:description"],
			["property", "og:type"],
			["property", "og:site_name"],
			["property", "og:image"],
			["property", "og:url"],
			["name", "twitter:card"],
		] as const) {
			expect(count(k, v), v).toBe(1);
		}
		expect(meta.filter((m) => "title" in m)).toEqual([{ title: "T" }]);
		expect(meta).toContainEqual({
			property: "og:image",
			content: "https://gavelup.app/og/default.png",
		});
		expect(meta).toContainEqual({
			property: "og:url",
			content: "https://gavelup.app/club/x",
		});
		expect(meta).toContainEqual({
			name: "robots",
			content: "noindex, nofollow",
		});
	});

	it("omits og:url without a path", () => {
		expect(
			shareMeta({ title: "T", description: "D" }).some(
				(m) => m.property === "og:url",
			),
		).toBe(false);
	});
});

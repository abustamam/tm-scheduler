import { describe, expect, it } from "vitest";
import { absoluteUrl, NOINDEX, shareMeta } from "#/lib/share-meta";

describe("absoluteUrl", () => {
	it("prefixes the production origin and leaves absolute URLs alone", () => {
		expect(absoluteUrl("/landing/hero.png")).toBe(
			"https://gavelup.app/landing/hero.png",
		);
		expect(absoluteUrl("tour")).toBe("https://gavelup.app/tour");
		expect(absoluteUrl("https://x.test/a.png")).toBe("https://x.test/a.png");
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
			content: "https://gavelup.app/landing/hero.png",
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

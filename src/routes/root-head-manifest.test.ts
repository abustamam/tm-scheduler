// protects: the root document head links the manifest and both theme-color
// metas, so Android Chrome can offer install. fails_when: either is dropped
// from `head`. no_claim: calls the route's head() directly; it does not assert on the
// server-rendered HTML (no in-process SSR harness for the root shell exists).
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

type Tag = Record<string, string>;

describe("root head", () => {
	it("links the manifest and light/dark theme-color", async () => {
		const { Route } = await import("./__root");
		const head = (
			Route as unknown as {
				options: { head: () => { meta: Tag[]; links: Tag[] } };
			}
		).options.head();
		expect(head.links).toContainEqual({
			rel: "manifest",
			href: "/manifest.json",
		});
		expect(head.meta).toContainEqual({
			name: "theme-color",
			content: "#f3faf5",
			media: "(prefers-color-scheme: light)",
		});
		expect(head.meta).toContainEqual({
			name: "theme-color",
			content: "#0a1418",
			media: "(prefers-color-scheme: dark)",
		});
	});
});

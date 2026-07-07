/**
 * Unit tests for the pure Base Camp page-walk. Injectable fetch, no browser.
 * Run: cd extension && bunx vitest run lib/basecamp-walk.test.ts
 */
import { describe, expect, it } from "vitest";
import { type BcmPage, walkProgressPages } from "./basecamp-walk";

function mockFetch(pages: BcmPage[]) {
	return async (url: string) => {
		const pageParam = new URL(url).searchParams.get("page");
		const idx = pageParam ? Number(pageParam) - 1 : 0;
		const page = pages[idx];
		if (!page) throw new Error(`no mock page ${idx}`);
		return { ok: true, status: 200, json: async () => page };
	};
}

describe("walkProgressPages", () => {
	it("follows `next` until null and returns every page object", async () => {
		const pages: BcmPage[] = [
			{ results: [{ a: 1 }], next: "https://x/api/bcm/progress/?club=g&page=2" },
			{ results: [{ a: 2 }], next: "https://x/api/bcm/progress/?club=g&page=3" },
			{ results: [{ a: 3 }], next: null },
		];
		const out = await walkProgressPages({
			fetchImpl: mockFetch(pages),
			guid: "g",
			csrftoken: "csrf",
		});
		expect(out).toHaveLength(3);
		expect(out.flatMap((p) => p.results)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
	});

	it("sends the required Base Camp headers", async () => {
		let seen: { url: string; opts: RequestInit } | undefined;
		const capture = async (url: string, opts: RequestInit) => {
			seen = { url, opts };
			return { ok: true, status: 200, json: async () => ({ results: [], next: null }) };
		};
		await walkProgressPages({ fetchImpl: capture, guid: "abc", csrftoken: "tok" });
		expect(seen?.url).toContain("club=abc");
		const headers = seen?.opts.headers as Record<string, string>;
		expect(headers["X-CSRFToken"]).toBe("tok");
		expect(headers["X-Platform"]).toBe("pathways");
		expect(seen?.opts.credentials).toBe("include");
	});

	it("aborts on a non-ok page and throws with the page number (all-or-nothing)", async () => {
		const failOnTwo = async (url: string) => {
			const page = Number(new URL(url).searchParams.get("page") ?? "1");
			if (page === 2) return { ok: false, status: 500, json: async () => ({}) };
			return {
				ok: true,
				status: 200,
				json: async () => ({ results: [], next: "https://x/api/bcm/progress/?club=g&page=2" }),
			};
		};
		await expect(
			walkProgressPages({ fetchImpl: failOnTwo, guid: "g", csrftoken: "t" }),
		).rejects.toThrow(/page 2/i);
	});

	it("throws if guid is missing", async () => {
		await expect(
			walkProgressPages({ fetchImpl: mockFetch([]), guid: "", csrftoken: "t" }),
		).rejects.toThrow(/club/i);
	});
});

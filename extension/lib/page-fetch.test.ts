import { describe, expect, it } from "vitest";
import { type PageGlobal, pageFetch } from "./page-fetch";

const URL_ = "https://easy-speak.org/clubdata.php";
const INIT: RequestInit = { credentials: "include" };

function recorder(name: string, calls: string[]): typeof fetch {
	return ((url: string, init: RequestInit) => {
		calls.push(`${name} ${url} ${init.credentials}`);
		return Promise.resolve(new Response(name));
	}) as typeof fetch;
}

describe("pageFetch", () => {
	// Firefox: the plain fetch goes out as the extension and Cloudflare answers 403.
	it("uses content.fetch when the browser provides it", async () => {
		const calls: string[] = [];
		const scope: PageGlobal = {
			fetch: recorder("global", calls),
			content: { fetch: recorder("content", calls) },
		};
		const res = await pageFetch(scope)(URL_, INIT);
		expect(await res.text()).toBe("content");
		expect(calls).toEqual([`content ${URL_} include`]);
	});

	// Chrome: no `content`, and the plain fetch already goes out as the page.
	it("falls back to the plain fetch when there is no content.fetch", async () => {
		const calls: string[] = [];
		const res = await pageFetch({ fetch: recorder("global", calls) })(URL_, INIT);
		expect(await res.text()).toBe("global");
		expect(calls).toEqual([`global ${URL_} include`]);
	});

	it("falls back when content exists without a fetch", async () => {
		const calls: string[] = [];
		const res = await pageFetch({ fetch: recorder("global", calls), content: {} })(
			URL_,
			INIT,
		);
		expect(await res.text()).toBe("global");
	});

	// A detached native fetch throws "Illegal invocation"; it must be called on its owner.
	it("calls content.fetch on its owner", async () => {
		const content = {
			fetch(this: unknown) {
				expect(this).toBe(content);
				return Promise.resolve(new Response("ok"));
			},
		};
		const scope = { fetch: recorder("global", []), content } as unknown as PageGlobal;
		expect(await (await pageFetch(scope)(URL_, INIT)).text()).toBe("ok");
	});
});

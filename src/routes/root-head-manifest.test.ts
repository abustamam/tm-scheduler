// protects: the RENDERED root document head carries the manifest link and both
// theme-color metas (light and dark, each with its media, neither duplicated).
// HeadContent de-duplicates metas by `name`, so a theme-color placed in
// head().meta silently loses one (#1463). fails_when: either meta is removed
// from the shell, or moved back into head().meta where it collapses.
// no_claim: renders the shell through a real router with renderToString; it
// does not run the client hydration pass (that is `bun run test:hydration`).
import {
	createMemoryHistory,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

async function renderHead(): Promise<string> {
	const { Route } = await import("./__root");
	const index = createRoute({
		getParentRoute: () => Route,
		path: "/",
		component: () => null,
	});
	const router = createRouter({
		routeTree: Route.addChildren([index]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
		context: { queryClient: {} as never },
	});
	await router.load();
	const html = renderToString(createElement(RouterProvider, { router }));
	return html.slice(html.indexOf("<head"), html.indexOf("</head>"));
}

describe("root head (rendered)", () => {
	it("renders the manifest link and exactly one light and one dark theme-color", async () => {
		const head = await renderHead();
		expect(head).toContain('rel="manifest"');
		const metas = head.match(/<meta[^>]*name="theme-color"[^>]*>/g) ?? [];
		expect(metas).toHaveLength(2);
		expect(
			metas.filter(
				(m) =>
					m.includes('content="#f3faf5"') &&
					m.includes('media="(prefers-color-scheme: light)"'),
			),
		).toHaveLength(1);
		expect(
			metas.filter(
				(m) =>
					m.includes('content="#0a1418"') &&
					m.includes('media="(prefers-color-scheme: dark)"'),
			),
		).toHaveLength(1);
	});
});

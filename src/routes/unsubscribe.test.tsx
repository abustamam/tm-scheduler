// @vitest-environment jsdom
//
// `/unsubscribe` is static (#902, ADR-0028). Every role-reminder email ever sent
// links here with a signed `?token=`; reminder emails are gone, so the page must
// still render for that link (and for a bare visit), read no token, call no
// server fn, and keep the Toastmasters disclaimer it has always carried.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { Route } from "./unsubscribe";

afterEach(cleanup);

/**
 * Any static, side-effect or dynamic import of a `server/` module, through
 * either alias (`#/`, `@/`) or a relative path.
 */
const SERVER_IMPORT =
	/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](?:#\/|@\/|(?:\.\.?\/)+)server\//;

/** Mount the route's component at `url` under a memory router. */
async function mountAt(url: string) {
	const rootRoute = createRootRoute();
	const page = createRoute({
		getParentRoute: () => rootRoute,
		path: "/unsubscribe",
		component: Route.options.component,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([page]),
		history: createMemoryHistory({ initialEntries: [url] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("/unsubscribe (static since #902)", () => {
	it.each([
		"/unsubscribe",
		"/unsubscribe?token=anything",
	])("%s says there is nothing to unsubscribe from", async (url) => {
		await mountAt(url);
		expect(
			screen.getByText(
				"GavelUp no longer sends reminder emails, so there is nothing to unsubscribe from.",
			),
		).toBeTruthy();
		expect(screen.getByText(TOASTMASTERS_DISCLAIMER)).toBeTruthy();
	});

	it("has no loader, no beforeLoad and no search schema, so it reads no token", () => {
		expect(Route.options.loader).toBeUndefined();
		expect(Route.options.beforeLoad).toBeUndefined();
		expect(Route.options.validateSearch).toBeUndefined();
	});

	it("imports nothing from the server, so it can call no server fn", () => {
		const src = readFileSync(
			resolve(process.cwd(), "src/routes/unsubscribe.tsx"),
			"utf8",
		);
		expect(src).not.toMatch(SERVER_IMPORT);
	});

	// The regex has to catch every spelling of a server import, or the guard
	// above reads green while the page calls a server fn again.
	it.each([
		'import { x } from "#/server/clubs";',
		'import { x } from "@/server/clubs";',
		'import { x } from "../server/clubs";',
		'import { x } from "./server/clubs";',
		'import "#/server/clubs";',
		'const m = await import("#/server/clubs");',
		"const m = await import('../server/clubs');",
	])("SERVER_IMPORT recognises %s", (line) => {
		expect(line).toMatch(SERVER_IMPORT);
	});

	it("SERVER_IMPORT leaves a non-server import alone", () => {
		expect('import { x } from "#/lib/brand";').not.toMatch(SERVER_IMPORT);
	});
});

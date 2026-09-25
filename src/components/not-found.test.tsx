// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotFound } from "./not-found";

/** A router wired as `src/router.tsx` wires the 404: the DEFAULT component. */
function renderAt(path: string) {
	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const homeRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <p>Home page</p>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([homeRoute]),
		history: createMemoryHistory({ initialEntries: [path] }),
		defaultNotFoundComponent: NotFound,
	});
	return render(<RouterProvider router={router} />);
}

describe("NotFound (on the shared StatusScreen, #878)", () => {
	afterEach(() => {
		cleanup();
	});

	it("renders the 404 copy and a Go home link for an unmatched path", async () => {
		renderAt("/no/such/page");
		expect(await screen.findByText("Page not found")).toBeTruthy();
		expect(
			screen.getByText("That page doesn't exist, or the link is out of date."),
		).toBeTruthy();
		const home = screen.getByRole("link", { name: "Go home" });
		expect(home.getAttribute("href")).toBe("/");
		// The branded frame, shared with the error page.
		expect(screen.getAllByText("GavelUp").length).toBeGreaterThan(0);
		// A 404 is not an error: nothing to retry.
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});
});

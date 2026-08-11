import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Mounts `ui` under a minimal single-route router and waits for the router's
 * first render pass to go idle.
 *
 * Anything rendering a `<Link>` throws outside a router context, which covers
 * most of this app's surfaces — the meeting toolbar and export menu (the two
 * copies this was first extracted from), the season grid, and any route
 * component mounted over stubbed loader data.
 *
 * REACH FOR THIS rather than hand-rolling the four-line
 * `createRootRoute`/`createRouter`/`render`/`waitFor` scaffold. The WhatsApp
 * phone-links branch added four more inline copies before anyone noticed this
 * file existed, which is exactly the drift it was extracted to prevent. Route
 * tests keep only their own `vi.spyOn(Route, …)` stubs local and pass
 * `<Component />` here.
 */
export async function renderUnderMemoryRouter(
	ui: React.ReactNode,
): Promise<void> {
	const rootRoute = createRootRoute({
		component: () => ui,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	// Let the router finish its first render pass.
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

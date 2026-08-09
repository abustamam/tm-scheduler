import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Mounts `ui` under a minimal single-route router and waits for the
 * router's first render pass to go idle. Components under test render
 * `<Link>`s (Present/Minutes/export menu), which throw outside a router
 * context — this is the shared harness `meeting-toolbar.test.tsx` and
 * `meeting-export-menu.test.tsx` both need, extracted so the two copies
 * can't drift apart.
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

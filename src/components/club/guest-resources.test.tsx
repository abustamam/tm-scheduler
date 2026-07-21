// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GuestResources } from "./guest-resources";

afterEach(cleanup);

// GuestResources renders <Link>s, so mount it under a minimal router — mirrors
// the pattern in onboarding-checklist.test.tsx.
async function renderGuestResources() {
	const rootRoute = createRootRoute({ component: () => <GuestResources /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("GuestResources", () => {
	it("links to the three guest-relevant resources", async () => {
		await renderGuestResources();
		expect(screen.getByText(/what to expect/i)).toBeTruthy();
		expect(screen.getByText(/first-time guest faq/i)).toBeTruthy();
		expect(screen.getByText(/meeting roles/i)).toBeTruthy();
	});
});

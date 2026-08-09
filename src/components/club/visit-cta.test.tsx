// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VisitCta } from "./visit-cta";

afterEach(cleanup);

async function renderCta({
	clubId = "harbor-city",
	clubName = "Harbor City Speakers",
}: {
	clubId?: string;
	clubName?: string;
} = {}) {
	const rootRoute = createRootRoute({
		component: () => <VisitCta clubId={clubId} clubName={clubName} />,
	});
	rootRoute.addChildren([
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/club/$clubId/guest-book",
			component: () => null,
		}),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const { container } = render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	return container;
}

describe("VisitCta", () => {
	it("invites an anonymous visitor to sign the guest book", async () => {
		await renderCta();
		expect(screen.getByText(/planning a visit/i)).toBeTruthy();
	});

	// The whole point of #319: the guest book was reachable only through the
	// printed QR code an officer generates. Assert the RESOLVED href, so a link
	// that silently stops pointing at the funnel fails here.
	it("points at THIS club's guest book", async () => {
		await renderCta({ clubId: "harbor-city" });
		const href = screen
			.getByRole("link", { name: /guest book/i })
			.getAttribute("href");
		expect(href).toBe("/club/harbor-city/guest-book");
	});

	it("carries the club through to the guest-book link", async () => {
		await renderCta({ clubId: "another-club" });
		expect(
			screen.getByRole("link", { name: /guest book/i }).getAttribute("href"),
		).toBe("/club/another-club/guest-book");
	});

	it("names the club so the invitation isn't generic", async () => {
		await renderCta({ clubName: "Harbor City Speakers" });
		expect(screen.getByText(/Harbor City Speakers/)).toBeTruthy();
	});
});

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
	isMember = false,
}: {
	clubId?: string;
	clubName?: string;
	isMember?: boolean;
} = {}) {
	const rootRoute = createRootRoute({
		component: () => (
			<VisitCta clubId={clubId} clubName={clubName} isMember={isMember} />
		),
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

	// A signed-in member of this club is not planning a visit. Asserting on the
	// rendered output being EMPTY (not on a flag) is what makes deleting the
	// guard fail.
	it("renders nothing for a signed-in member of this club", async () => {
		const container = await renderCta({ isMember: true });
		expect(container.innerHTML).toBe("");
	});

	it("does not link to the guest book at all for a member", async () => {
		await renderCta({ isMember: true });
		expect(screen.queryByRole("link", { name: /guest book/i })).toBeNull();
	});
});

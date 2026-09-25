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
import { PILOT_PRICING_LINE } from "#/lib/brand";
import { MarketingCta } from "./marketing-cta";

afterEach(cleanup);

// Stub routes for every link target, so hrefs resolve as they do in the app.
async function renderCta() {
	const rootRoute = createRootRoute({ component: () => <MarketingCta /> });
	const stub = (path: string) =>
		createRoute({
			getParentRoute: () => rootRoute,
			path,
			component: () => null,
		});
	rootRoute.addChildren([stub("/tour"), stub("/districts")]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("MarketingCta", () => {
	it("links to /tour and /districts, and carries the pilot pricing line", async () => {
		await renderCta();
		expect(
			screen
				.getByRole("link", { name: "See how it works →" })
				.getAttribute("href"),
		).toBe("/tour");
		expect(
			screen
				.getByRole("link", { name: "Running a district? →" })
				.getAttribute("href"),
		).toBe("/districts");
		expect(screen.getByText(PILOT_PRICING_LINE)).toBeTruthy();
	});

	// #610's copy rule: say what GavelUp does, never characterise alternatives
	// or TI's own tooling. The card sits directly above the TI disclaimer.
	it("never characterises alternatives or TI's tooling", async () => {
		await renderCta();
		const text = (
			screen.getByRole("complementary").textContent ?? ""
		).toLowerCase();
		expect(text).toContain("your club could run its meetings here.");
		for (const banned of ["tired", "toastmasters international", "software"]) {
			expect(text).not.toContain(banned);
		}
	});
});

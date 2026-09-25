// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { FOOTER_LINKS, HEADER_LINKS, MarketingShell } from "./marketing-shell";

afterEach(cleanup);

// MarketingShell renders <Link>s, so mount it under a minimal router whose
// stub tree carries every target path, so hrefs resolve as they do in the app.
async function renderShell() {
	const rootRoute = createRootRoute({
		component: () => (
			<MarketingShell>
				<main>page body</main>
			</MarketingShell>
		),
	});
	const stub = (path: string) =>
		createRoute({
			getParentRoute: () => rootRoute,
			path,
			component: () => null,
		});
	rootRoute.addChildren([
		stub("/tour"),
		stub("/resources"),
		stub("/districts"),
		stub("/about"),
		stub("/signin"),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

function hrefsIn(el: HTMLElement): Record<string, string> {
	return Object.fromEntries(
		within(el)
			.getAllByRole("link")
			.map((a) => [a.textContent ?? "", a.getAttribute("href") ?? ""]),
	);
}

describe("MarketingShell", () => {
	it("renders its children between the header and the footer", async () => {
		await renderShell();
		const body = screen.getByText("page body");
		const header = screen.getByRole("banner");
		const footer = screen.getByRole("contentinfo");
		expect(
			header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("renders every HEADER_LINKS entry in the header nav, with its search", async () => {
		await renderShell();
		const hrefs = hrefsIn(screen.getByRole("navigation"));
		expect(Object.keys(hrefs)).toEqual(HEADER_LINKS.map((l) => l.label));
		// #870: the literal set too, so dropping an entry from the array fails.
		expect(Object.keys(hrefs)).toEqual([
			"How it works",
			"Resources",
			"Sign in",
		]);
		expect(hrefs["How it works"]).toBe("/tour");
		expect(hrefs.Resources).toBe("/resources");
		expect(hrefs["Sign in"]).toBe("/signin?redirect=%2Fofficers");
	});

	it("renders every FOOTER_LINKS entry in the footer, with its search", async () => {
		await renderShell();
		const hrefs = hrefsIn(screen.getByRole("contentinfo"));
		expect(Object.keys(hrefs)).toEqual(FOOTER_LINKS.map((l) => l.label));
		expect(Object.keys(hrefs)).toEqual([
			"How it works",
			"Resources",
			"For districts",
			"About",
			"Sign in",
		]);
		expect(hrefs["How it works"]).toBe("/tour");
		expect(hrefs.Resources).toBe("/resources");
		expect(hrefs["For districts"]).toBe("/districts");
		expect(hrefs.About).toBe("/about");
		expect(hrefs["Sign in"]).toBe("/signin?redirect=%2Fofficers");
	});

	it("renders the canonical TI disclaimer in the footer", async () => {
		await renderShell();
		expect(
			within(screen.getByRole("contentinfo")).getByText(
				TOASTMASTERS_DISCLAIMER,
			),
		).toBeTruthy();
	});
});

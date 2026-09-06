// @vitest-environment jsdom
/**
 * The category filter on /resources (#313), driven the way a reader drives it.
 *
 * Mounted here and not through the route: `src/routes/resources.index.tsx`
 * cannot be mounted in vitest, and a source grep over it can see neither which
 * cards a click leaves on the page nor what an empty list renders instead of a
 * grid. The route keeps a one-line call that `resources-index-catalog.guard.test.ts`
 * pins; everything below is the behaviour.
 */
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Resource,
	type ResourceCategory,
	resources,
} from "#/data/resources";
import { countLabel, ResourceCatalog } from "./resource-catalog";

afterEach(cleanup);

const entry = (slug: string, cat: ResourceCategory): Resource => ({
	slug,
	cat,
	icon: "doc",
	tone: "ink",
	title: `Title ${slug}`,
	desc: `Desc ${slug}`,
});

/**
 * The cards are `<Link>`s, so they need a router with the target path really
 * declared — same scaffold as `guest-resources.test.tsx`, which is why this
 * does not use `renderUnderMemoryRouter` (that harness mounts a root route with
 * no children, and `/resources/$slug` would not resolve).
 */
async function renderCatalog(items?: readonly Resource[]) {
	const rootRoute = createRootRoute({
		component: () => <ResourceCatalog items={items} />,
	});
	rootRoute.addChildren([
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/resources/$slug",
			component: () => null,
		}),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

const cards = () => screen.queryAllByRole("link");
const chip = (name: string) => screen.getByRole("button", { name });

describe("ResourceCatalog — first paint", () => {
	it("shows every registry article, with no filter applied", async () => {
		await renderCatalog();
		expect(cards()).toHaveLength(resources.length);
		expect(chip("All").getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByText(`All ${resources.length} resources`)).toBeTruthy();
	});

	it("offers one chip per category the registry actually uses", async () => {
		await renderCatalog();
		const group = screen.getByRole("group", {
			name: "Filter resources by category",
		});
		const labels = Array.from(group.querySelectorAll("button")).map(
			(b) => b.textContent,
		);
		expect(labels).toEqual(["All", ...new Set(resources.map((r) => r.cat))]);
	});
});

describe("ResourceCatalog — selecting a category", () => {
	it("shows exactly that category's articles, and marks the chip pressed", async () => {
		await renderCatalog();
		const cat: ResourceCategory = "Roles";
		const expected = resources.filter((r) => r.cat === cat);
		// Anti-vacuity: the assertions below are meaningless if the filter is a
		// no-op because every article is already in this category.
		expect(expected.length).toBeGreaterThan(0);
		expect(expected.length).toBeLessThan(resources.length);

		await userEvent.click(chip(cat));

		expect(cards()).toHaveLength(expected.length);
		for (const r of expected) expect(screen.getByText(r.title)).toBeTruthy();
		for (const r of resources.filter((r) => r.cat !== cat)) {
			expect(screen.queryByText(r.title)).toBeNull();
		}
		expect(chip(cat).getAttribute("aria-pressed")).toBe("true");
		expect(chip("All").getAttribute("aria-pressed")).toBe("false");
		expect(
			screen.getByText(`${expected.length} of ${resources.length} resources`),
		).toBeTruthy();
	});

	it("the All chip is the way back to the unfiltered list", async () => {
		await renderCatalog();
		await userEvent.click(chip("Pathways"));
		expect(cards().length).toBeLessThan(resources.length);

		await userEvent.click(chip("All"));

		expect(cards()).toHaveLength(resources.length);
		expect(chip("All").getAttribute("aria-pressed")).toBe("true");
	});

	it("re-pressing the category you are already on is not a dead end", async () => {
		await renderCatalog();
		await userEvent.click(chip("Meeting"));
		const shown = cards().length;
		await userEvent.click(chip("Meeting"));
		expect(cards()).toHaveLength(shown);
		expect(chip("Meeting").getAttribute("aria-pressed")).toBe("true");
	});
});

describe("ResourceCatalog — the option list follows the data", () => {
	it("renders a chip per category present, and none for one that is absent", async () => {
		await renderCatalog([
			entry("a", "Pathways"),
			entry("b", "Meeting"),
			entry("c", "Pathways"),
		]);
		const labels = Array.from(
			screen
				.getByRole("group", { name: "Filter resources by category" })
				.querySelectorAll("button"),
		).map((b) => b.textContent);
		expect(labels).toEqual(["All", "Pathways", "Meeting"]);
		expect(screen.queryByRole("button", { name: "Roles" })).toBeNull();
	});

	it("hides the chip row entirely when there is only one category to pick", async () => {
		await renderCatalog([entry("a", "Roles"), entry("b", "Roles")]);
		expect(
			screen.queryByRole("group", { name: "Filter resources by category" }),
		).toBeNull();
		expect(cards()).toHaveLength(2);
	});
});

describe("ResourceCatalog — empty", () => {
	it("renders a message, not an empty grid", async () => {
		await renderCatalog([]);
		expect(cards()).toHaveLength(0);
		expect(screen.getByText("Nothing to show here yet.")).toBeTruthy();
		// The grid box itself must be gone: `auto-fill` over zero children is a
		// blank band, which reads as a broken page.
		expect(document.querySelector('[class*="repeat(auto-fill"]')).toBeNull();
	});
});

describe("countLabel", () => {
	it("says so plainly when nothing is filtered out", () => {
		expect(countLabel(11, 11)).toBe("All 11 resources");
	});

	it("shows the narrowed count against the total", () => {
		expect(countLabel(4, 11)).toBe("4 of 11 resources");
	});

	it("does not say '1 resources'", () => {
		expect(countLabel(1, 1)).toBe("All 1 resource");
		expect(countLabel(0, 1)).toBe("0 of 1 resource");
	});
});

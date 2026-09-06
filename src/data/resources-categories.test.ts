/**
 * The pure half of the resources index filter (#313): which categories exist,
 * and what one of them selects. Rendering is covered by
 * `src/components/resources/resource-catalog.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import {
	filterResourcesByCategory,
	type Resource,
	type ResourceCategory,
	resourceCategories,
	resources,
} from "#/data/resources";

const entry = (slug: string, cat: ResourceCategory): Resource => ({
	slug,
	cat,
	icon: "doc",
	tone: "ink",
	title: `Title ${slug}`,
	desc: `Desc ${slug}`,
});

describe("resourceCategories", () => {
	it("returns each category the real registry uses, exactly once", () => {
		const got = resourceCategories();
		expect(new Set(got)).toEqual(new Set(resources.map((r) => r.cat)));
		expect(got.length).toBe(new Set(got).size);
		// Anti-vacuity: a registry that somehow lost every entry would satisfy the
		// set comparison above with two empty sets.
		expect(got.length).toBeGreaterThan(1);
	});

	it("orders them by first mention in the registry", () => {
		expect(
			resourceCategories([
				entry("a", "Pathways"),
				entry("b", "Meeting"),
				entry("c", "Pathways"),
			]),
		).toEqual(["Pathways", "Meeting"]);
	});

	it("omits a category with no entries — it can never become a dead-end chip", () => {
		expect(resourceCategories([entry("a", "Roles")])).toEqual(["Roles"]);
	});

	it("is derived, not a hardcoded list of today's three values", () => {
		// Stands in for widening `ResourceCategory` and adding an article: the
		// cast is the only part of that change this test cannot make for real,
		// and the point is that the derivation needs no edit to see it.
		const future = "Contests" as ResourceCategory;
		expect(
			resourceCategories([entry("a", "Roles"), entry("b", future)]),
		).toEqual(["Roles", future]);
	});

	it("returns nothing for an empty registry", () => {
		expect(resourceCategories([])).toEqual([]);
	});
});

describe("filterResourcesByCategory", () => {
	it("null is the unfiltered default", () => {
		expect(filterResourcesByCategory(null)).toHaveLength(resources.length);
	});

	it("returns a copy, so a caller cannot mutate the registry through it", () => {
		const all = filterResourcesByCategory(null);
		expect(all).not.toBe(resources);
		all.pop();
		expect(resources).toHaveLength(all.length + 1);
	});

	it("keeps only that category, and every registry entry in it", () => {
		for (const cat of resourceCategories()) {
			const got = filterResourcesByCategory(cat);
			expect(got.every((r) => r.cat === cat)).toBe(true);
			expect(got).toHaveLength(resources.filter((r) => r.cat === cat).length);
			expect(got.length).toBeGreaterThan(0);
		}
	});

	it("returns nothing for a category no entry carries", () => {
		expect(filterResourcesByCategory("Roles", [entry("a", "Meeting")])).toEqual(
			[],
		);
	});
});

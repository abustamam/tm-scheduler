// @vitest-environment jsdom
//
// `/districts` rendered (#868): the seven sections in order, where "Talk to us"
// goes, the search contract that keeps SSR from 307ing, and the words the page
// must not say. The disclaimer is the marketing guard's
// (`marketing-disclaimer.guard.test.ts`), which enrols this route by content.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PILOT_PRICING_LINE, TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { Route } from "./districts";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

async function mount(d?: string | number) {
	vi.spyOn(Route, "useSearch").mockReturnValue({ d } as never);
	const Component = Route.options.component as React.ComponentType;
	await renderUnderMemoryRouter(<Component />);
}

const section = (id: string) => {
	const el = document.querySelector<HTMLElement>(`[data-section="${id}"]`);
	if (!el) throw new Error(`no [data-section="${id}"]`);
	return el;
};

describe("/districts (#868)", () => {
	it("renders the seven sections in order, inside the marketing shell", async () => {
		await mount();
		const order = [
			...document.querySelectorAll<HTMLElement>("main [data-section]"),
		].map((el) => el.dataset.section);
		expect(order).toEqual([
			"hero",
			"clubs-get",
			"rollout",
			"cost",
			"talk",
			"share",
			"founder",
		]);
		expect(
			within(section("hero")).getByRole("heading", {
				level: 1,
				name: "Help more of your clubs run great meetings.",
			}),
		).toBeTruthy();
		expect(within(section("cost")).getByText(PILOT_PRICING_LINE)).toBeTruthy();
		expect(
			within(section("clubs-get"))
				.getByRole("link", { name: "See the tour →" })
				.getAttribute("href"),
		).toBe("/tour");
		expect(
			within(section("share")).getByLabelText("Your district number"),
		).toBeTruthy();
		// The shell's footer, i.e. the TI disclaimer, unchanged.
		expect(screen.getByText(TOASTMASTERS_DISCLAIMER)).toBeTruthy();
	});

	// No district is named as a customer. The share block's own output is the
	// one place a district number may appear, so it is cut out before looking.
	it("names no district anywhere outside the share block's own output", async () => {
		await mount("57");
		await waitFor(() => expect(screen.getByTestId("share-blurb")).toBeTruthy());
		const page = document.body.cloneNode(true) as HTMLElement;
		for (const el of page.querySelectorAll(
			'[data-testid="district-share-output"], input',
		)) {
			el.remove();
		}
		const text = page.textContent ?? "";
		expect(text).toContain("Help more of your clubs");
		expect(text).not.toMatch(/\bdistrict\s*#?\s*\d+/i);
		expect(text).not.toMatch(/\bD\d{1,3}\b/);
	});

	// MarketingShell owns the page's one toast container; the share block's copy
	// toasts render there, and a second container would show each toast twice.
	it("has exactly one toast container, the shell's", async () => {
		await mount("57");
		await waitFor(() =>
			expect(
				document.querySelectorAll('section[aria-label^="Notifications"]'),
			).toHaveLength(1),
		);
	});

	it("points 'Talk to us' at the district request form", async () => {
		await mount();
		expect(
			within(section("talk"))
				.getByRole("link", { name: "Talk to us about your district" })
				.getAttribute("href"),
		).toBe("/request-access?kind=district");
	});

	// No district-management claim or hint, and no outcome promise in the hero.
	it("says none of the banned phrases, and the hero does not promise Distinguished", async () => {
		await mount("57");
		const text = document.body.textContent ?? "";
		for (const banned of [
			/dashboard/i,
			/manage your district/i,
			/coming soon/i,
			/roadmap/i,
		]) {
			expect(text).not.toMatch(banned);
		}
		expect(section("hero").textContent).not.toMatch(/distinguished/i);
	});

	// AC2. The router parses `?d=57` as the number 57; if validateSearch hands
	// back anything other than what it was given, SSR answers with a 307.
	it("returns the parsed search unchanged, number or string, and feeds String(d) to the share block", async () => {
		const validate = Route.options.validateSearch as (
			s: Record<string, unknown>,
		) => unknown;
		expect(validate({ d: 57 })).toStrictEqual({ d: 57 });
		expect(validate({ d: "F" })).toStrictEqual({ d: "F" });
		// Strict: a `{ d: undefined }` here is a search that differs from `{}`.
		expect(validate({})).toStrictEqual({});

		await mount(57);
		await waitFor(() =>
			expect(screen.getByTestId("share-blurb").textContent).toContain(
				"/?ref=district-57",
			),
		);
	});
});

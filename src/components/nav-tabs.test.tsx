// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { destinationFor } from "#/lib/nav-destinations";
import { NavTabs, NEW_MEETINGS_TABS, PATHWAYS_SYNC_TABS } from "./nav-tabs";

let pathname = "/";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		children,
		"aria-current": ariaCurrent,
	}: {
		to: string;
		children: ReactNode;
		"aria-current"?: "page";
	}) => (
		<a href={to} aria-current={ariaCurrent}>
			{children}
		</a>
	),
	useRouterState: ({
		select,
	}: {
		select: (s: { location: { pathname: string } }) => string;
	}) => select({ location: { pathname } }),
}));

afterEach(() => {
	cleanup();
});

describe.each([
	["New meetings", NEW_MEETINGS_TABS],
	["Pathways sync", PATHWAYS_SYNC_TABS],
])("%s tab row", (entry, tabs) => {
	it("pairs two pages that belong to the same nav entry", () => {
		expect(tabs).toHaveLength(2);
		for (const tab of tabs) expect(destinationFor(tab.to)?.label).toBe(entry);
	});

	for (const here of tabs) {
		it(`on ${here.to}, links both ways and marks only this page current`, () => {
			pathname = `${here.to}/`;
			render(<NavTabs tabs={tabs} label={entry} />);
			const nav = screen.getByRole("navigation", { name: entry });
			const links = [...nav.querySelectorAll("a")];
			expect(links.map((a) => a.getAttribute("href"))).toEqual(
				tabs.map((t) => t.to),
			);
			expect(
				links
					.filter((a) => a.getAttribute("aria-current") === "page")
					.map((a) => a.getAttribute("href")),
			).toEqual([here.to]);
		});
	}
});

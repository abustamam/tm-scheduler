// @vitest-environment jsdom
//
// The colour fix for the date pills is a CSS-cascade change, and the guard test
// beside this file (`meeting-nav-link-color.guard.test.ts`) covers both halves
// it can see: the `:not([data-slot="meeting-nav-link"])` arm on the unlayered
// text-link rule, and the `data-slot` literal in this component's source.
//
// One link in that chain is neither of those, and no source grep can see it:
// these pills are a TanStack `<Link>`, not a bare `<a>`, so the exclusion only
// works if `Link` FORWARDS an unknown `data-*` prop through to the anchor it
// renders. If it ever stopped, both guard assertions would stay green, the
// attribute would never reach the DOM, and the unlayered rule would repaint the
// active pill at 1.19:1 again with nothing failing. jsdom loads no stylesheet
// so it cannot check the colour — but it can check the attribute arrives, which
// is the half the greps are blind to.
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MeetingNavItem } from "#/lib/meeting-nav";
import { MeetingNavStrip } from "./meeting-nav-strip";

afterEach(cleanup);

// jsdom doesn't implement scrollIntoView; the strip re-centers the active pill
// on mount, and the unhandled TypeError takes the whole component down through
// the router's error boundary — so without this stub every assertion below
// fails on "no links found" rather than on the attribute. Same stub as
// `season-grid.test.tsx` and `nudge-recruit-picker.test.tsx`.
Element.prototype.scrollIntoView = () => {};

const ITEMS: MeetingNavItem[] = [
	{
		meetingId: "m1",
		urlKey: "2026-08-13",
		label: "Aug 13",
		isCurrent: false,
		hasOpenRoles: false,
	},
	{
		meetingId: "m2",
		urlKey: "2026-08-27",
		label: "Aug 27",
		isCurrent: true,
		hasOpenRoles: false,
	},
	{
		meetingId: "m3",
		urlKey: "2026-09-10",
		label: "Sep 10",
		isCurrent: false,
		hasOpenRoles: true,
	},
];

async function renderStrip(items: MeetingNavItem[] = ITEMS) {
	const rootRoute = createRootRoute({
		component: () => <MeetingNavStrip clubId="harbor-city" items={items} />,
	});
	rootRoute.addChildren([
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/club/$clubId/meeting/$meetingId",
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

describe("MeetingNavStrip", () => {
	it("stamps data-slot on EVERY pill that reaches the DOM", async () => {
		await renderStrip();
		const links = screen.getAllByRole("link");
		// Anti-vacuity: an empty list would make the loop below pass on nothing.
		expect(links).toHaveLength(ITEMS.length);
		for (const link of links) {
			expect(
				link.getAttribute("data-slot"),
				`"${link.textContent}" reached the DOM without ` +
					'data-slot="meeting-nav-link" — the unlayered text-link rule in ' +
					"styles.css will repaint it, and on the ACTIVE pill that is " +
					"--lagoon-deep on a --primary fill (1.19:1 in dark mode).",
			).toBe("meeting-nav-link");
		}
	});

	// The active pill is the one that was illegible, and it is also the one
	// whose `data-slot` shares an element with `aria-current` — assert them on
	// the SAME node so a future refactor cannot satisfy this by stamping the
	// slot on a wrapper.
	it("stamps it on the active pill, alongside aria-current", async () => {
		await renderStrip();
		const active = screen.getByRole("link", { name: /Aug 27/ });
		expect(active.getAttribute("aria-current")).toBe("page");
		expect(active.getAttribute("data-slot")).toBe("meeting-nav-link");
	});

	it("keeps the strip's own behaviour: hides itself below two items", async () => {
		await renderStrip([ITEMS[0] as MeetingNavItem]);
		expect(screen.queryAllByRole("link")).toHaveLength(0);
	});
});

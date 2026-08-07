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
import { resourceBySlug } from "#/data/resources";
import { GUEST_LINKS, GuestResources } from "./guest-resources";

afterEach(cleanup);

// GuestResources renders <Link>s, so mount it under a minimal router — mirrors
// the pattern in onboarding-checklist.test.tsx. The strip now links OUT of the
// generic resources area to a club-scoped route (#318), so the stub tree must
// carry both target paths for hrefs to resolve.
async function renderGuestResources(clubId = "harbor-city") {
	const rootRoute = createRootRoute({
		component: () => <GuestResources clubId={clubId} />,
	});
	const stub = (path: string) =>
		createRoute({
			getParentRoute: () => rootRoute,
			path,
			component: () => null,
		});
	rootRoute.addChildren([
		stub("/resources/$slug"),
		stub("/club/$clubId/roles-guide"),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

/** The rendered <a> whose text starts with `label`. */
function linkHref(label: RegExp): string {
	const el = screen.getByText(label).closest("a");
	expect(el, `no <a> around ${label}`).toBeTruthy();
	return el?.getAttribute("href") ?? "";
}

describe("GuestResources", () => {
	it("links to the three guest-relevant resources", async () => {
		await renderGuestResources();
		expect(screen.getByText(/what to expect/i)).toBeTruthy();
		expect(screen.getByText(/first-time guest faq/i)).toBeTruthy();
		expect(screen.getByText(/meeting roles/i)).toBeTruthy();
	});

	it("every generic guest link points to a real resource slug", () => {
		for (const { slug } of GUEST_LINKS) {
			expect(
				resourceBySlug(slug),
				`unknown resource slug: ${slug}`,
			).toBeTruthy();
		}
	});

	// The #318 behavior change. Before, this strip rendered on a club's own page
	// while sending "Meeting roles" to the GENERIC article — routing a guest away
	// from the page describing that club's actual roles. Asserting the resolved
	// href (not just that a link exists) is what makes a revert to
	// `/resources/meeting-roles` fail this test.
	it("points 'Meeting roles' at THIS club, not the generic article", async () => {
		await renderGuestResources("harbor-city");
		const href = linkHref(/meeting roles/i);
		expect(href).toBe("/club/harbor-city/roles-guide");
		expect(href).not.toContain("/resources/");
	});

	it("carries the club through to the roles link", async () => {
		await renderGuestResources("another-club");
		expect(linkHref(/meeting roles/i)).toBe("/club/another-club/roles-guide");
	});

	// Guards the reason "Meeting roles" was removed from GUEST_LINKS: if it were
	// added back, the loop above would render a second, generic link with the
	// same label and the club-scoped assertion would start matching whichever
	// came first.
	it("does not also expose meeting-roles as a generic link", () => {
		expect(GUEST_LINKS.some((l) => l.slug === "meeting-roles")).toBe(false);
	});
});

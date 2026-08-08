// @vitest-environment jsdom
//
// The guest-onboarding gate (#318 / #319).
//
// This block is three cards' worth of content for someone who does not know the
// club: what it is and when it meets, what a Toastmasters meeting is, and how to
// say you're coming. Shown to a MEMBER it is pure obstruction — measured at
// 390x844, the sign-up sheet they came for started 693px down with 151px of grid
// above the fold; hiding the block moves it to 447px and 397px.
//
// The gate lives on this component, not in the route's JSX, so the branch is
// unit-testable — the seventh coverage trap in CLAUDE.md is exactly the bug that
// shipped when it lived at the call site.
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicClubProfile } from "#/server/clubs-logic";
import { GuestOnboarding } from "./guest-onboarding";

afterEach(cleanup);

const PROFILE: PublicClubProfile = {
	district: "District 206",
	mission: "Building leaders.",
	meetingSchedule: "2nd & 4th Thursday, 6:45 PM",
};

async function renderBlock(hasIdentity: boolean) {
	const rootRoute = createRootRoute({
		component: () => (
			<GuestOnboarding
				hasIdentity={hasIdentity}
				clubId="harbor-city"
				clubName="Harbor City Speakers"
				profile={PROFILE}
			/>
		),
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
		stub("/club/$clubId/guest-book"),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const { container } = render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	return container;
}

describe("GuestOnboarding", () => {
	it("shows all three cards to a visitor who doesn't belong here yet", async () => {
		await renderBlock(false);
		expect(screen.getByText(/About Harbor City Speakers/)).toBeTruthy();
		expect(screen.getByText(/New to Toastmasters\?/)).toBeTruthy();
		expect(screen.getByText(/Planning a visit\?/)).toBeTruthy();
	});

	/**
	 * Asserting the rendered output is EMPTY, not that some flag is set — the
	 * observable is "none of this is in the member's way", and a flag assertion
	 * would pass with the block still rendering.
	 */
	it("renders NOTHING for someone who already belongs here", async () => {
		expect((await renderBlock(true)).innerHTML).toBe("");
	});

	/**
	 * Named individually so a partial regression — one card escaping the gate —
	 * fails with a message that says which one, rather than an opaque
	 * innerHTML diff.
	 */
	it.each([
		["the club's basics", /About Harbor City Speakers/],
		["the Toastmasters intro strip", /New to Toastmasters\?/],
		["the visit call-to-action", /Planning a visit\?/],
	])("hides %s from a member", async (_label, pattern) => {
		await renderBlock(true);
		expect(screen.queryByText(pattern)).toBeNull();
	});

	/**
	 * The gate is one rule for the whole block precisely so the three cannot
	 * disagree. If a future change re-adds a per-card gate, this catches the
	 * half-migrated state where the block hides but a card does not.
	 */
	it("gates the block as a unit — no card survives on its own", async () => {
		await renderBlock(true);
		expect(screen.queryAllByRole("link")).toHaveLength(0);
	});
});

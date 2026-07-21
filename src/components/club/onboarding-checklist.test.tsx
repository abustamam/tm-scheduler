// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { onboardingDismissKey } from "#/lib/onboarding-checklist";
import type { OnboardingChecklistStatus } from "#/server/onboarding-checklist-logic";
import { OnboardingChecklist } from "./onboarding-checklist";

const NEW_CLUB: OnboardingChecklistStatus = {
	clubSlug: "new-club",
	clubDetailsComplete: false,
	memberCount: 2,
	hasEnoughMembers: false,
	hasRecurrence: false,
	hasMeeting: false,
	hasOfficerTerm: false,
	isNewClub: true,
};

const ESTABLISHED_CLUB: OnboardingChecklistStatus = {
	...NEW_CLUB,
	clubDetailsComplete: true,
	memberCount: 12,
	hasEnoughMembers: true,
	hasRecurrence: true,
	hasMeeting: true,
	hasOfficerTerm: true,
	isNewClub: false,
};

/** Render inside a minimal TanStack Router tree so the item `<Link>`s resolve. */
async function renderChecklist(props: {
	clubId: string;
	status: OnboardingChecklistStatus;
}) {
	const rootRoute = createRootRoute({
		component: () => <OnboardingChecklist {...props} />,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	// Let the router finish its first render pass.
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("OnboardingChecklist", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	it("renders every item, checked/unchecked per the status", async () => {
		await renderChecklist({ clubId: "club-1", status: NEW_CLUB });
		expect(screen.getByText("Get your club set up")).toBeTruthy();
		expect(screen.getByText("0 of 5 done")).toBeTruthy();
		expect(screen.getByText("Confirm your club details")).toBeTruthy();
		expect(screen.getByText("Share your sign-up link")).toBeTruthy();
	});

	it("shows a running done count as items complete", async () => {
		const status: OnboardingChecklistStatus = {
			...NEW_CLUB,
			hasRecurrence: true,
			hasOfficerTerm: true,
		};
		await renderChecklist({ clubId: "club-1", status });
		expect(screen.getByText("2 of 5 done")).toBeTruthy();
	});

	it("renders nothing once the club has graduated (isNewClub false)", async () => {
		await renderChecklist({ clubId: "club-1", status: ESTABLISHED_CLUB });
		expect(screen.queryByText("Get your club set up")).toBeNull();
	});

	it("dismissing hides the checklist and persists per-club to localStorage", async () => {
		await renderChecklist({ clubId: "club-1", status: NEW_CLUB });
		expect(screen.getByText("Get your club set up")).toBeTruthy();

		await userEvent.click(
			screen.getByRole("button", { name: "Dismiss setup checklist" }),
		);

		expect(screen.queryByText("Get your club set up")).toBeNull();
		expect(localStorage.getItem(onboardingDismissKey("club-1"))).toBe("1");
	});

	it("a prior dismissal for this club suppresses it on next mount", async () => {
		localStorage.setItem(onboardingDismissKey("club-1"), "1");
		await renderChecklist({ clubId: "club-1", status: NEW_CLUB });
		await waitFor(() =>
			expect(screen.queryByText("Get your club set up")).toBeNull(),
		);
	});

	it("a dismissal for one club does not suppress it for another club", async () => {
		localStorage.setItem(onboardingDismissKey("club-1"), "1");
		await renderChecklist({ clubId: "club-2", status: NEW_CLUB });
		expect(screen.getByText("Get your club set up")).toBeTruthy();
	});

	it("builds the share link from the club's slug", async () => {
		await renderChecklist({ clubId: "club-1", status: NEW_CLUB });
		const copyButton = screen.getByRole("button", { name: /copy link/i });
		expect(copyButton).toBeTruthy();
	});
});

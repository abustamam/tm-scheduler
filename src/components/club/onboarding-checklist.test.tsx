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
import {
	onboardingDismissKey,
	onboardingPathKey,
} from "#/lib/onboarding-checklist";
import type { OnboardingChecklistStatus } from "#/server/onboarding-checklist-logic";
import { OnboardingChecklist } from "./onboarding-checklist";

const NEW_CLUB: OnboardingChecklistStatus = {
	clubSlug: "new-club",
	clubDetailsComplete: false,
	memberCount: 2,
	hasEnoughMembers: false,
	invitedMemberCount: 0,
	hasInvitedMembers: false,
	hasRecurrence: false,
	hasMeeting: false,
	hasOfficerTerm: false,
	isNewClub: true,
	officialRosterCount: 0,
	hasOfficialRoster: false,
	hasImport: false,
	hasAppliedImport: false,
	hasUpcomingMeeting: false,
	isNewClubEasySpeak: true,
	canRunImport: true,
};

const ESTABLISHED_CLUB: OnboardingChecklistStatus = {
	...NEW_CLUB,
	clubDetailsComplete: true,
	memberCount: 12,
	hasEnoughMembers: true,
	invitedMemberCount: 12,
	hasInvitedMembers: true,
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
		expect(screen.getByText("0 of 6 done")).toBeTruthy();
		expect(screen.getByText("Confirm your club details")).toBeTruthy();
		expect(screen.getByText("Invite your members")).toBeTruthy();
		expect(screen.getByText("Share your sign-up link")).toBeTruthy();
	});

	it("shows a running done count as items complete", async () => {
		const status: OnboardingChecklistStatus = {
			...NEW_CLUB,
			hasRecurrence: true,
			hasOfficerTerm: true,
		};
		await renderChecklist({ clubId: "club-1", status });
		expect(screen.getByText("2 of 6 done")).toBeTruthy();
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

	it("draws a done step's check in the success colour, never the link teal", async () => {
		await renderChecklist({
			clubId: "club-1",
			status: { ...NEW_CLUB, clubDetailsComplete: true },
		});
		const checks = document.querySelectorAll("svg.text-success");
		expect(checks.length).toBeGreaterThan(0);
		expect(document.querySelector("svg.text-link")).toBeNull();
	});

	// protects=the path switch line; fails_when=it does not write/clear the key or
	// shows after an import; no_claim=server data (statuses are fixtures).
	it("the switch line writes the path key and the way back clears it", async () => {
		await renderChecklist({ clubId: "club-1", status: NEW_CLUB });
		await userEvent.click(
			screen.getByRole("button", { name: "Show the migration steps" }),
		);
		expect(localStorage.getItem(onboardingPathKey("club-1"))).toBe(
			"easy-speak",
		);
		expect(screen.getByText("Move your club to GavelUp")).toBeTruthy();
		await userEvent.click(
			screen.getByRole("button", { name: "Show the standard steps" }),
		);
		expect(localStorage.getItem(onboardingPathKey("club-1"))).toBeNull();
		expect(screen.getByText("Get your club set up")).toBeTruthy();
	});

	it("shows no switch line once the club has an import", async () => {
		await renderChecklist({
			clubId: "club-1",
			status: { ...NEW_CLUB, hasImport: true },
		});
		expect(screen.getByText("Move your club to GavelUp")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /show the/i })).toBeNull();
	});

	it("numbers rows and puts one Next badge on the first incomplete row", async () => {
		await renderChecklist({
			clubId: "club-1",
			status: { ...NEW_CLUB, clubDetailsComplete: true },
		});
		const numbers = screen
			.getAllByTestId("checklist-number")
			.map((n) => n.textContent);
		expect(numbers).toEqual(["1.", "2.", "3.", "4.", "5.", "6."]);
		const next = screen.getAllByTestId("checklist-next");
		expect(next).toHaveLength(1);
		expect(next[0].parentElement?.textContent).toContain("Import your roster");
	});

	it("renders a locked row without a link and with the admin-only text", async () => {
		await renderChecklist({
			clubId: "club-1",
			status: { ...NEW_CLUB, hasImport: true, canRunImport: false },
		});
		expect(screen.getAllByText("A club admin does this step.")).toHaveLength(2);
		const history = screen.getByText("Import your Easy-Speak history");
		expect(history.closest("a")).toBeNull();
		const roster = screen.getByText("Load your official roster");
		expect(roster.closest("a")).not.toBeNull();
	});

	it("on the Easy-Speak path graduation follows its own flag", async () => {
		await renderChecklist({
			clubId: "club-1",
			status: { ...NEW_CLUB, hasImport: true, isNewClubEasySpeak: false },
		});
		expect(screen.queryByText("Move your club to GavelUp")).toBeNull();
	});
});

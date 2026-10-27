// @vitest-environment jsdom
// The officer home's render: its tasks as one grouped list (FINDING-005) and
// the keyboard focus ring on every link. The beforeLoad bounce has its own
// suite in `officers.test.ts`.
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

// Both server-fn modules reach `#/db` on import; the loader never runs here.
vi.mock("#/server/onboarding-checklist", () => ({
	getOnboardingChecklist: vi.fn(),
}));
vi.mock("#/server/charter", () => ({ getCharterSummary: vi.fn() }));

import { Route } from "./officers";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

async function renderHome(charter: unknown) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		authUser: { name: "Rae Officer", email: "rae@example.test" },
		officerPositions: ["president"],
		adminClub: { clubId: "club-1" },
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		checklist: { isNewClub: false },
		charter,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	await renderUnderMemoryRouter(
		(Route.options.component as () => React.ReactElement)(),
	);
}

const FOCUS_RING = "focus-visible:ring-[3px]";

describe("officer home", () => {
	// Pins structure and classes only: jsdom paints no ring and lays out
	// nothing.
	it("lists each section's tasks as links in one list, each with the focus ring", async () => {
		await renderHome(null);
		const everyday = screen.getByRole("heading", { name: "Everyday" })
			.parentElement as HTMLElement;
		const lists = within(everyday).getAllByRole("list");
		expect(lists).toHaveLength(1);
		const links = within(lists[0]).getAllByRole("link");
		expect(links.length).toBeGreaterThan(0);
		for (const link of links) expect(link.className).toContain(FOCUS_RING);
	});

	it("gives the charter card the same focus ring", async () => {
		await renderHome({
			membersNeeded: 20,
			paidCount: 8,
			periodPicked: true,
			stepsDone: 2,
			stepsTotal: 6,
		});
		expect(screen.getByTestId("charter-card").className).toContain(FOCUS_RING);
	});
});

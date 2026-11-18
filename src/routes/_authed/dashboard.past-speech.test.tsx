// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

/**
 * Past speeches (#1656) on the dashboard's speech log.
 *
 * protects=past rows render the loose date and Past badge, undated rows sit
 *   under one "Earlier" divider, the speaker gets the pencil on their own, and
 *   the dashboard has NO "Add past speech" button
 * fails_when=the past branch drops the date cell/divider, or an add button is
 *   rendered on the dashboard
 * no_claim=the server gate and the merge order (past-speeches-logic.test.ts)
 */
const { stubModule } = vi.hoisted(() => ({
	stubModule: () =>
		new Proxy(
			{},
			{ get: (_t, key) => (key === "then" ? undefined : () => undefined) },
		),
}));
vi.mock("#/server/club", stubModule);
vi.mock("#/server/meetings", stubModule);
vi.mock("#/server/mentorship", stubModule);
vi.mock("#/server/milestones", stubModule);
vi.mock("#/server/orientation", stubModule);
vi.mock("#/server/path-enrollment", stubModule);
vi.mock("#/server/pathways-read", stubModule);
vi.mock("#/server/progress-marks", stubModule);
vi.mock("#/server/role-feedback", stubModule);
vi.mock("#/server/speeches", stubModule);
vi.mock("#/server/slots", stubModule);
vi.mock("#/server/project-picker", stubModule);
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { Route } from "./dashboard";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function past(over: Record<string, unknown>) {
	return {
		kind: "past" as const,
		memberId: "member-1",
		deliveredYear: null,
		deliveredMonth: null,
		recordedClubId: "club-1",
		speechTitle: "x",
		pathwayPath: null,
		projectName: null,
		projectLevel: null,
		projectId: null,
		minMinutes: null,
		maxMinutes: null,
		presentationUrl: null,
		introduction: null,
		...over,
	};
}

describe("dashboard speech log — past speech rows (#1656)", () => {
	it("renders dated and undated past rows read-only with a pencil each and no add button", async () => {
		vi.spyOn(Route, "useRouteContext").mockReturnValue({
			authUser: { id: "u1", name: "Ada" },
			activeClubId: null,
			clubs: [],
			officerPositions: [],
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		} as any);
		vi.spyOn(Route, "useLoaderData").mockReturnValue({
			commitments: [],
			speeches: [
				past({
					speechId: "p1",
					speechTitle: "Ice Breaker",
					deliveredYear: 2023,
					deliveredMonth: 3,
				}),
				past({ speechId: "p2", speechTitle: "Year Only", deliveredYear: 2022 }),
				past({ speechId: "p3", speechTitle: "No Date" }),
			],
			speechLogTruncated: false,
			allSpeeches: false,
			pathways: [],
			enrollments: [],
			pathOptions: [],
			feedback: { meetings: [], unseenCount: 0 },
			orientation: null,
			mentorship: null,
			clubMentoring: null,
			timezone: "UTC",
			now: Date.parse("2026-10-01T00:00:00Z"),
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		} as any);
		const Component = Route.options.component as () => React.ReactElement;
		await renderUnderMemoryRouter(<Component />);

		const rowOf = (t: string) =>
			screen.getByText(t).closest("div.grid") as HTMLElement;
		expect(rowOf("Ice Breaker").textContent).toContain("MAR");
		expect(rowOf("Ice Breaker").textContent).toContain("2023");
		expect(rowOf("Ice Breaker").textContent).toContain("Past");
		expect(rowOf("Year Only").textContent).toContain("2022");
		expect(rowOf("No Date").textContent).toContain("—");
		expect(screen.getAllByText("Earlier")).toHaveLength(1);
		expect(
			screen.getAllByRole("button", { name: "Edit speech details" }),
		).toHaveLength(3);
		expect(
			screen.queryByRole("button", { name: "Add past speech" }),
		).toBeNull();
	});
});

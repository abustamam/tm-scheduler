// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

/**
 * AC7 (#1159): every row of the dashboard's speech log is the viewer's own, so
 * every row wears the edit pencil. The route is rendered with its loader data
 * stubbed, as `members.$id.test.tsx` does.
 */

// Every server module the page imports is a stub that answers any named export
// with a no-op fn: nothing here is called, the page only has to import.
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

function row(i: number) {
	return {
		slotId: `slot-${i}`,
		memberId: "member-1",
		scheduledAt: new Date(`2026-08-${10 + i}T18:00:00Z`),
		roleName: "Speaker",
		speechTitle: `Speech ${i}`,
		projectName: null,
		pathwayPath: null,
		projectLevel: null,
		projectId: null,
		minMinutes: null,
		maxMinutes: null,
		presentationUrl: null,
		evaluators: [],
		hasEvaluatorSlot: false,
		status: "confirmed" as const,
	};
}

describe("dashboard speech log edit buttons (#1159)", () => {
	it("every speech row has an edit button", async () => {
		vi.spyOn(Route, "useRouteContext").mockReturnValue({
			authUser: { id: "u1", name: "Ada" },
			activeClubId: null,
			clubs: [],
			officerPositions: [],
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		} as any);
		vi.spyOn(Route, "useLoaderData").mockReturnValue({
			commitments: [],
			speeches: [row(1), row(2), row(3)],
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

		expect(screen.getByText("Speech 1")).toBeTruthy();
		expect(
			screen.getAllByRole("button", { name: "Edit speech details" }),
		).toHaveLength(3);
	});
});

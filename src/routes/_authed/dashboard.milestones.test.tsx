// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

/**
 * The dashboard's milestone wiring (#1425): the real route component is
 * rendered over stubbed loader data, as `dashboard.speech-log-edit.test.tsx`
 * does, so the card's mount is read from the route, not from hand-typed markup.
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

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

async function mountWith(milestones: unknown) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		authUser: { id: "u1", name: "Ada" },
		activeClubId: null,
		clubs: [],
		officerPositions: [],
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		commitments: [],
		speeches: [],
		speechLogTruncated: false,
		allSpeeches: false,
		pathways: [],
		enrollments: [],
		pathOptions: [],
		feedback: { meetings: [], unseenCount: 0 },
		orientation: null,
		mentorship: null,
		clubMentoring: null,
		milestones,
		timezone: "UTC",
		now: Date.parse("2026-10-01T00:00:00Z"),
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

describe("dashboard milestone card wiring (#1425)", () => {
	// protects=the dashboard mounts the milestone card from the loader's milestones, passing memberId and the counts; fails_when=the card is not mounted, or the counts or memberId are not passed through; no_claim=once-only behaviour (milestone-card.test.tsx)
	it("shows the first-speech card when the loader reports a delivered speech", async () => {
		await mountWith({
			memberId: "m1",
			speechesDelivered: 1,
			meetingsAttended: 0,
		});
		expect(await screen.findByText("Your first speech is done.")).toBeTruthy();
		expect(
			JSON.parse(localStorage.getItem("gavelup:milestones") ?? "[]"),
		).toEqual(["m1:firstSpeech"]);
	});

	// protects=no card when the milestones read is null (no membership, or the read failed); fails_when=the null guard is dropped and the card renders or throws; no_claim=the loader
	it("shows no card when milestones is null", async () => {
		await mountWith(null);
		expect(screen.queryByText("Your first speech is done.")).toBeNull();
		expect(screen.queryByRole("button", { name: "Nice" })).toBeNull();
	});
});

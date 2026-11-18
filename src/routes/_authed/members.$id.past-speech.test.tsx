// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

/**
 * Past speeches (#1656) as the member profile renders them. The route is
 * rendered with its loader data stubbed, as `members.$id.test.tsx` does; the
 * date cell, divider, badge and button come from the real components.
 *
 * protects=past rows render MAR/2023, 2023 and a dash, the "Earlier" divider
 *   sits once before the undated rows, and "Add past speech" shows only to the
 *   viewer `mayShowSpeechLogEdit` allows
 * fails_when=the date cell or divider is dropped from the past branch, or the
 *   button stops following `showSpeechEdit`
 * no_claim=the server gate (past-speeches-logic.test.ts); CSS/layout
 */
const { stubModule } = vi.hoisted(() => ({
	stubModule: () =>
		new Proxy(
			{},
			{ get: (_t, key) => (key === "then" ? undefined : () => undefined) },
		),
}));
vi.mock("#/server/club", stubModule);
vi.mock("#/server/members", stubModule);
vi.mock("#/server/mentorship", stubModule);
vi.mock("#/server/orientation", stubModule);
vi.mock("#/server/path-enrollment", stubModule);
vi.mock("#/server/pathways-read", stubModule);
vi.mock("#/server/progress-marks", stubModule);
vi.mock("#/server/speeches", stubModule);
vi.mock("#/server/slots", stubModule);
vi.mock("#/server/project-picker", stubModule);
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { Route } from "./members.$id";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

function past(
	over: Record<string, unknown> & { speechId: string; speechTitle: string },
) {
	return {
		kind: "past" as const,
		memberId: MEMBER_ID,
		deliveredYear: null,
		deliveredMonth: null,
		recordedClubId: CLUB_ID,
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

async function renderProfile(opts: {
	speechLog: unknown[];
	viewerRole?: "admin" | "member";
	viewerUserId?: string;
	memberUserId?: string | null;
}) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [
			{
				clubId: CLUB_ID,
				name: "Downtown Club",
				clubNumber: "123456",
				clubRole: opts.viewerRole ?? "admin",
			},
		],
		activeClubId: CLUB_ID,
		officerPositions: [],
		authUser: { id: opts.viewerUserId ?? "viewer-user" },
		impersonating: null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		member: {
			id: MEMBER_ID,
			name: "Ada Member",
			preferredName: null,
			phone: null,
			phoneRaw: null,
			email: null,
			officerPositions: [],
			userId: opts.memberUserId ?? null,
			status: "active",
			clubRole: "member",
			createdAt: new Date("2024-01-15T00:00:00Z"),
			joinedAt: new Date("2024-01-15T00:00:00Z"),
			originalJoinDate: null,
		},
		speechLog: opts.speechLog,
		rolesServed: [],
		speeches: opts.speechLog.length,
		pathways: [],
		unscheduledSpeeches: [],
		openSpeakerSlots: [],
		pathOptions: [],
		enrollments: [],
		speechLogTruncated: false,
		allSpeeches: false,
		now: Date.parse("2026-09-24T12:00:00Z"),
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

const LOG = [
	past({
		speechId: "p1",
		speechTitle: "Ice Breaker",
		deliveredYear: 2023,
		deliveredMonth: 3,
	}),
	past({ speechId: "p2", speechTitle: "Year Only", deliveredYear: 2022 }),
	past({ speechId: "p3", speechTitle: "No Date" }),
	past({ speechId: "p4", speechTitle: "Also No Date" }),
];

describe("member profile — past speech rows (#1656)", () => {
	it("renders the loose date, the Past badge and one Earlier divider before the undated rows", async () => {
		await renderProfile({ speechLog: LOG });
		const titleRow = (t: string) =>
			screen.getByText(t).closest("div.grid") as HTMLElement;
		const first = titleRow("Ice Breaker");
		expect(first.textContent).toContain("MAR");
		expect(first.textContent).toContain("2023");
		expect(first.textContent).toContain("Past");
		const second = titleRow("Year Only");
		expect(second.textContent).toContain("2022");
		expect(second.textContent).not.toMatch(/JAN|FEB|MAR|APR|MAY|JUN/);
		expect(titleRow("No Date").textContent).toContain("—");
		expect(screen.getAllByText("Earlier")).toHaveLength(1);
		const divider = screen.getByText("Earlier");
		const noDate = screen.getByText("No Date");
		const yearOnly = screen.getByText("Year Only");
		expect(
			divider.compareDocumentPosition(noDate) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			yearOnly.compareDocumentPosition(divider) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("shows no divider when every past row is dated", async () => {
		await renderProfile({ speechLog: [LOG[0], LOG[1]] });
		expect(screen.queryByText("Earlier")).toBeNull();
	});

	it("shows Add past speech to an officer, and in the empty state", async () => {
		await renderProfile({ speechLog: [], viewerRole: "admin" });
		expect(screen.getByText("No speeches logged yet.")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Add past speech" }),
		).toBeTruthy();
	});

	it("shows Add past speech and the row pencils to the speaker themselves", async () => {
		await renderProfile({
			speechLog: LOG,
			viewerRole: "member",
			viewerUserId: "u-ada",
			memberUserId: "u-ada",
		});
		expect(
			screen.getByRole("button", { name: "Add past speech" }),
		).toBeTruthy();
		expect(
			screen.getAllByRole("button", { name: "Edit speech details" }),
		).toHaveLength(LOG.length);
	});

	it("hides Add past speech and the pencils from a non-officer who is not the speaker", async () => {
		await renderProfile({
			speechLog: LOG,
			viewerRole: "member",
			viewerUserId: "someone-else",
			memberUserId: "u-ada",
		});
		expect(
			screen.queryByRole("button", { name: "Add past speech" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Edit speech details" }),
		).toBeNull();
	});
});

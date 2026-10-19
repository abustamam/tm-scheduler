// @vitest-environment jsdom
//
// Component tests for the roster's former-member handling (#1239).
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/account-invite", () => ({
	inviteAllMembers: vi.fn(),
	inviteMember: vi.fn(),
}));
vi.mock("#/server/club", () => ({
	listClubMembers: vi.fn(),
}));
// The loader reads the club's zone for tenure (#1017).
vi.mock("#/server/clubs", () => ({
	loadClubTimezoneSettings: vi.fn(async () => ({
		timezone: "America/Chicago",
		zones: [],
	})),
}));
vi.mock("#/server/meetings", () => ({
	listUpcomingMeetings: vi.fn(),
}));
vi.mock("#/server/members", () => ({
	bulkImportMembers: vi.fn(),
	listFormerMembers: vi.fn(),
	mergeMembers: vi.fn(),
	setMemberStatus: vi.fn(),
}));
vi.mock("#/server/pathways-read", () => ({
	listClubMemberPathways: vi.fn(),
}));
vi.mock("#/server/upload-members", () => ({
	commitMemberUpload: vi.fn(),
	previewMemberUpload: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

import { Route } from "./roster";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

function memberRow(name: string, status: "active" | "inactive" | "former") {
	return {
		id: crypto.randomUUID(),
		name,
		email: null,
		phone: null,
		officerPositions: [] as string[],
		userId: null,
		invitedAt: null,
		status,
		createdAt: new Date("2024-01-15T00:00:00Z"),
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		originalJoinDate: null,
		speeches: 0,
	};
}

async function renderRoute(
	members: ReturnType<typeof memberRow>[],
	canManage: boolean,
	formerMembers: { id: string; name: string; endedAt: string | null }[],
) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [
			{
				clubId: CLUB_ID,
				name: "Downtown Club",
				clubNumber: "123456",
				clubRole: canManage ? "admin" : "member",
			},
		],
		activeClubId: CLUB_ID,
		officerPositions: [],
		impersonating: null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		members,
		openRoles: 0,
		pathways: {},
		formerPathwaysRequested: false,
		formerMembers,
		timezone: "UTC",
		now: Date.parse("2026-09-15T12:00:00Z"),
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

describe("roster former members (#1239)", () => {
	// protects=a former member never appears as a roster row, whichever segment is shown;
	// fails_when=the row list renders a former membership;
	// no_claim=the server's own exclusion (the stubbed loader sends one anyway).
	it("hides a former member from the roster", async () => {
		await renderRoute(
			[memberRow("Ada Active", "active"), memberRow("Fred Former", "former")],
			false,
			[],
		);
		expect(screen.getByText("Ada Active")).toBeTruthy();
		expect(screen.queryByText("Fred Former")).toBeNull();
	});

	// protects="Former members (N)" shows the count to an admin and is absent for a non-admin;
	// fails_when=the link renders for a member, or shows the wrong N;
	// no_claim=the server gate (covered by the listFormerMembers integration test).
	it("shows Former members (N) to admins only", async () => {
		const former = [
			{ id: "a", name: "Fred Former", endedAt: "2024-01-01" },
			{ id: "b", name: "Gina Former", endedAt: null },
		];
		await renderRoute([memberRow("Ada Active", "active")], true, former);
		expect(screen.getByText("Former members (2)")).toBeTruthy();
		cleanup();
		await renderRoute([memberRow("Ada Active", "active")], false, former);
		expect(screen.queryByText(/Former members \(/)).toBeNull();
	});
});

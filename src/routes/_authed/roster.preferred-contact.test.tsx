// @vitest-environment jsdom
//
// The roster's preferred-contact icon (#1093): one small icon per member for
// the EFFECTIVE method the server sent, labelled for a screen reader, and none
// when there is no preference. Same harness as `roster.test.tsx`.
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/account-invite", () => ({
	inviteAllMembers: vi.fn(),
	inviteMember: vi.fn(),
}));
vi.mock("#/server/club", () => ({ listClubMembers: vi.fn() }));
vi.mock("#/server/clubs", () => ({
	loadClubTimezoneSettings: vi.fn(async () => ({ timezone: "UTC", zones: [] })),
}));
vi.mock("#/server/meetings", () => ({ listUpcomingMeetings: vi.fn() }));
vi.mock("#/server/members", () => ({
	bulkImportMembers: vi.fn(),
	mergeMembers: vi.fn(),
}));
vi.mock("#/server/pathways-read", () => ({ listClubMemberPathways: vi.fn() }));
vi.mock("#/server/upload-members", () => ({
	commitMemberUpload: vi.fn(),
	previewMemberUpload: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { Route } from "./roster";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

function memberRow(id: string, name: string, preferredContact: unknown) {
	return {
		id,
		name,
		email: "x@example.com",
		phone: "+14155552671",
		preferredContact,
		officerPositions: [] as string[],
		userId: null,
		invitedAt: null,
		status: "active" as const,
		createdAt: new Date("2024-01-15T00:00:00Z"),
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		originalJoinDate: null,
		speeches: 0,
	};
}

async function renderRoster(members: ReturnType<typeof memberRow>[]) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [
			{ clubId: CLUB_ID, name: "C", clubNumber: "1", clubRole: "member" },
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
		timezone: "UTC",
		now: Date.parse("2026-09-15T12:00:00Z"),
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

function rowFor(name: string): HTMLElement {
	const overlay = screen.getByRole("link", { name: `Open ${name}'s profile` });
	return overlay.parentElement as HTMLElement;
}

describe("roster preferred-contact icon (#1093)", () => {
	it("labels each method and shows nothing without a preference", async () => {
		await renderRoster([
			memberRow("a0000000-0000-4000-8000-000000000001", "Amy Email", "email"),
			memberRow("a0000000-0000-4000-8000-000000000002", "Cal Call", "call"),
			memberRow("a0000000-0000-4000-8000-000000000003", "Sam Sms", "sms"),
			memberRow("a0000000-0000-4000-8000-000000000004", "Wes Wa", "whatsapp"),
			memberRow("a0000000-0000-4000-8000-000000000005", "Nora None", null),
		]);
		const label = (name: string) =>
			within(rowFor(name))
				.queryByTestId("preferred-contact-icon")
				?.getAttribute("aria-label") ?? null;
		expect(label("Amy Email")).toBe("Prefers Email");
		expect(label("Cal Call")).toBe("Prefers Call");
		expect(label("Sam Sms")).toBe("Prefers SMS");
		expect(label("Wes Wa")).toBe("Prefers WhatsApp");
		expect(label("Nora None")).toBeNull();
		expect(
			within(rowFor("Sam Sms")).getByRole("img", { name: "Prefers SMS" }),
		).toBeTruthy();
	});
});

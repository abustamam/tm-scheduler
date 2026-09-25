// @vitest-environment jsdom
//
// The two links to the club data export (#915): Club settings' "Your club's
// data" section and the roster's "Export club data". The roster's link replaced
// an "Export CSV" button that had no `onClick` at all, so the thing worth
// pinning is that each control is a real link to the real route, and that the
// dead label is gone (#915 AC4).
//
// Both hrefs are asserted as a literal path. That `clubExportUrl` builds the
// path the route file actually declares is asserted in
// `club-export-route.integration.test.ts`, which reads the declaration, so a
// renamed route file cannot leave both links pointing at a 404.
//
// Mocking follows roster.test.tsx / club-settings.test.tsx: every server-fn
// module is mocked (they reach `#/db` → `pg`, which must not load under jsdom),
// the route hooks are stubbed, and `Route.options.component` renders directly.
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/account-invite", () => ({
	inviteAllMembers: vi.fn(),
	inviteMember: vi.fn(),
}));
vi.mock("#/server/club", () => ({ listClubMembers: vi.fn() }));
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
vi.mock("#/server/clubs", () => ({
	getClubProfileSettings: vi.fn(),
	loadClubAgendaSettings: vi.fn(),
	loadClubTimezoneSettings: vi.fn(),
	updateClubAgendaSettings: vi.fn(),
	updateClubProfile: vi.fn(),
	updateClubTimezone: vi.fn(),
}));
vi.mock("#/server/notification-prefs", () => ({
	loadClubReminderSettings: vi.fn(),
	updateClubReminderSettings: vi.fn(),
}));
vi.mock("#/server/club-logo", () => ({
	getClubLogoMeta: vi.fn(),
	uploadClubLogo: vi.fn(),
	removeClubLogoFn: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { clubExportUrl } from "#/lib/club-export-url";
import { Route as ClubSettingsRoute } from "./admin/club-settings";
import { Route as RosterRoute } from "./roster";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const EXPORT_PATH = `/api/clubs/${CLUB_ID}/export/zip`;

async function renderRoster(opts: {
	clubRole: "admin" | "member";
	officerPositions?: string[];
}) {
	vi.spyOn(RosterRoute, "useRouteContext").mockReturnValue({
		clubs: [
			{
				clubId: CLUB_ID,
				name: "Downtown Club",
				clubNumber: "123456",
				clubRole: opts.clubRole,
			},
		],
		activeClubId: CLUB_ID,
		officerPositions: opts.officerPositions ?? [],
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(RosterRoute, "useLoaderData").mockReturnValue({
		members: [],
		openRoles: 0,
		pathways: {},
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = RosterRoute.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

async function renderClubSettings() {
	vi.spyOn(ClubSettingsRoute, "useRouteContext").mockReturnValue({
		adminClub: {
			clubId: CLUB_ID,
			name: "Downtown Club",
			clubNumber: "123456",
			clubRole: "admin",
		},
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(ClubSettingsRoute, "useLoaderData").mockReturnValue({
		profile: {
			name: "Downtown Club",
			district: "",
			mission: "",
			meetingSchedule: "",
			defaultCountryCode: "",
		},
		reminders: { enabled: true, leadTimeDays: 3 },
		agenda: {
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
			digitalVotingEnabled: true,
		},
		logoMeta: null,
		timezone: { timezone: "America/Chicago", zones: ["America/Chicago"] },
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = ClubSettingsRoute.options
		.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

describe("clubExportUrl", () => {
	it("is the path the route file serves", () => {
		expect(clubExportUrl(CLUB_ID)).toBe(EXPORT_PATH);
	});
});

describe("roster: Export club data", () => {
	it("is a download link to the export route for an admin", async () => {
		await renderRoster({ clubRole: "admin" });
		const link = screen.getByRole("link", { name: "Export club data" });
		expect(link.getAttribute("href")).toBe(EXPORT_PATH);
		expect(link.hasAttribute("download")).toBe(true);
	});

	it("is shown to an officer whose stored role is member, as the route admits them", async () => {
		await renderRoster({ clubRole: "member", officerPositions: ["treasurer"] });
		expect(
			screen
				.getByRole("link", { name: "Export club data" })
				.getAttribute("href"),
		).toBe(EXPORT_PATH);
	});

	it("is not shown to a plain member, whom the route would refuse", async () => {
		await renderRoster({ clubRole: "member" });
		expect(screen.queryByRole("link", { name: "Export club data" })).toBeNull();
	});

	// #915 AC4: the dead button is gone, for every viewer.
	it.each([
		"admin",
		"member",
	] as const)("has no control labelled Export CSV (%s)", async (clubRole) => {
		await renderRoster({ clubRole });
		expect(screen.queryByText(/export csv/i)).toBeNull();
	});
});

describe("club settings: Your club's data", () => {
	it("has the section, its copy, and a download link to the export route", async () => {
		await renderClubSettings();
		const heading = screen.getByRole("heading", {
			level: 2,
			name: "Your club's data",
		});
		const section = heading.closest("section");
		expect(section).not.toBeNull();
		expect(section?.textContent).toContain(
			"Download your club's roster, meetings, roles, attendance and guests as spreadsheets (CSV).",
		);
		const link = screen.getByRole("link", { name: "Download export" });
		expect(section?.contains(link)).toBe(true);
		expect(link.getAttribute("href")).toBe(EXPORT_PATH);
		expect(link.hasAttribute("download")).toBe(true);
	});
});

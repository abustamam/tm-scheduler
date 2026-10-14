// @vitest-environment jsdom
//
// The roster's wording when an invite comes back `notSent: "demo"` (#1200). The
// server skips the send in the demo club; the roster must say so instead of
// "Invite sent." (single) or "Sent 0 invites." (bulk).
//
// Same stubbing as roster.test.tsx: server-fn modules mocked, the route's hooks
// stubbed, `Route.options.component` rendered directly.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/account-invite", () => ({
	inviteAllMembers: vi.fn(),
	inviteMember: vi.fn(),
}));
vi.mock("#/server/club", () => ({ listClubMembers: vi.fn() }));
vi.mock("#/server/clubs", () => ({
	loadClubTimezoneSettings: vi.fn(async () => ({
		timezone: "America/Chicago",
		zones: [],
	})),
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

import { toast } from "sonner";
import { DEMO_INVITE_NOT_SENT } from "#/lib/demo-club-copy";
import { inviteAllMembers, inviteMember } from "#/server/account-invite";
import { Route } from "./roster";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

async function renderRoster() {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [
			{
				clubId: CLUB_ID,
				name: "Demo Club",
				clubNumber: null,
				clubRole: "admin",
			},
		],
		activeClubId: CLUB_ID,
		officerPositions: [],
		impersonating: null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		members: [
			{
				id: "22222222-2222-4222-8222-222222222222",
				name: "Ada Member",
				email: "ada@example.com",
				phone: null,
				officerPositions: [],
				userId: null,
				invitedAt: null,
				status: "active",
				createdAt: new Date("2024-01-15T00:00:00Z"),
				joinedAt: new Date("2024-01-15T00:00:00Z"),
				originalJoinDate: null,
				speeches: 0,
			},
		],
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

const BULK_BASE = {
	sent: 0,
	alreadyJoined: 0,
	noEmail: 0,
	rosterConflict: 0,
	recentlyInvited: 0,
	failed: 0,
};

describe("roster invite wording in the demo club (#1200)", () => {
	// protects=the single invite's toast names the demo club's "not sent" instead
	//   of claiming a send, and the real club's toast is unchanged;
	// fails_when=`notSent: "demo"` falls into the trailing "Invite sent." arm, or
	//   a normal result is told the demo wording;
	// no_claim=the server's decision to skip the send (its own integration test);
	//   `inviteMember` is a stub that returns the shapes the server returns.
	it("says the invite was not sent when the server reports the demo club, and 'Invite sent.' otherwise", async () => {
		vi.mocked(inviteMember).mockResolvedValueOnce({
			outcome: "ready",
			notSent: "demo",
		});
		await renderRoster();
		fireEvent.click(
			screen.getByRole("button", { name: "Send account invite" }),
		);
		await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
		expect(toast.info).toHaveBeenCalledWith(DEMO_INVITE_NOT_SENT);
		expect(toast.success).not.toHaveBeenCalled();

		vi.mocked(inviteMember).mockResolvedValueOnce({ outcome: "ready" });
		fireEvent.click(
			screen.getByRole("button", { name: "Send account invite" }),
		);
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith("Invite sent."),
		);
		expect(toast.info).toHaveBeenCalledTimes(1);
	});

	// protects=the bulk send's toast says "Demo club: invite not sent." rather than
	//   "Sent 0 invites.", and the real club's summary is unchanged;
	// fails_when=the demo result reaches the count summary, or a real result reads
	//   the demo wording;
	// no_claim=the server's counts; `inviteAllMembers` is a stub.
	it("says the bulk invite was not sent for the demo club, and keeps the count summary otherwise", async () => {
		vi.mocked(inviteAllMembers).mockResolvedValueOnce({
			...BULK_BASE,
			notSent: "demo",
		});
		await renderRoster();
		fireEvent.click(screen.getByRole("button", { name: /Invite all/ }));
		fireEvent.click(
			await screen.findByRole("button", { name: /^Send 1 invite/ }),
		);
		await waitFor(() =>
			expect(toast.info).toHaveBeenCalledWith(DEMO_INVITE_NOT_SENT),
		);
		expect(toast.success).not.toHaveBeenCalled();

		vi.mocked(inviteAllMembers).mockResolvedValueOnce({
			...BULK_BASE,
			sent: 1,
		});
		fireEvent.click(screen.getByRole("button", { name: /Invite all/ }));
		fireEvent.click(
			await screen.findByRole("button", { name: /^Send 1 invite/ }),
		);
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith("Sent 1 invite."),
		);
	});
});

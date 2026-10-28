// @vitest-environment jsdom
//
// Component tests for the roster's former-member handling (#1239).
import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setMemberStatus } from "#/server/members";
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

let force: (() => void) | null = null;

async function renderRoute(
	members: ReturnType<typeof memberRow>[],
	canManage: boolean,
	formerMembers: { id: string; name: string; endedAt: string | null }[],
	opts: {
		officerPositions?: string[];
		impersonating?: { mode: "read_only"; clubId: string } | null;
		formerFailed?: boolean;
	} = {},
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
		officerPositions: opts.officerPositions ?? [],
		impersonating: opts.impersonating ?? null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockImplementation(() => ({
		members,
		openRoles: 0,
		pathways: {},
		formerPathwaysRequested: false,
		formerMembers,
		formerFailed: opts.formerFailed ?? false,
		timezone: "UTC",
		now: Date.parse("2026-09-15T12:00:00Z"),
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	})) as any;
	const Component = Route.options.component as () => React.ReactElement;
	function Harness() {
		const [, setN] = useState(0);
		force = () => setN((n) => n + 1);
		return <Component />;
	}
	await renderUnderMemoryRouter(<Harness />);
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

	// protects=an officer who is NOT a stored admin sees the link (the server fn admits an effective admin), and a "View as" read-only session does not;
	// fails_when=the link keys off the stored role alone, or renders for a session the server refuses;
	// no_claim=the server gate itself (members-former.integration.test.ts); the session shape is stubbed.
	it("shows the link to an officer who is not an admin, not to a view-as session", async () => {
		const former = [{ id: "a", name: "Fred Former", endedAt: "2024-01-01" }];
		await renderRoute([memberRow("Ada Active", "active")], false, former, {
			officerPositions: ["president"],
		});
		expect(screen.getByText("Former members (1)")).toBeTruthy();
		cleanup();
		await renderRoute([memberRow("Ada Active", "active")], true, former, {
			impersonating: { mode: "read_only", clubId: CLUB_ID },
		});
		expect(screen.queryByText(/Former members \(/)).toBeNull();
	});

	// protects=a failed former-members load is shown as an error with a retry, never as "Former members (0)";
	// fails_when=the failure is swallowed into an empty count, or has no retry;
	// no_claim=that the loader sets formerFailed (stubbed here).
	it("shows an error with Retry, not a zero count, when the list failed to load", async () => {
		await renderRoute([memberRow("Ada Active", "active")], true, [], {
			formerFailed: true,
		});
		expect(screen.queryByText(/Former members \(\d/)).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Former members (couldn't load)" }),
		);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByRole("alert").textContent).toBe(
			"Former members could not be loaded.",
		);
		expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();
	});

	// protects=the entry point is absent for a club with no former members;
	// fails_when="Former members (0)" renders;
	// no_claim=the dialog's own empty state.
	it("has no entry point when there are none", async () => {
		await renderRoute([memberRow("Ada Active", "active")], true, []);
		expect(screen.queryByText(/Former members/)).toBeNull();
	});

	// protects=the dialog formats the end date, says so when unknown, and names each Reactivate;
	// fails_when=a raw key or a bare "Reactivate" name returns;
	// no_claim=the server's date (members-former integration test).
	it("dates rows, and names each Reactivate button", async () => {
		await renderRoute([memberRow("Ada Active", "active")], true, [
			{ id: "a", name: "Fred Former", endedAt: "2026-10-05" },
			{ id: "b", name: "Gina Former", endedAt: null },
		]);
		fireEvent.click(screen.getByRole("button", { name: "Former members (2)" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("Ended Oct 5, 2026")).toBeTruthy();
		expect(within(dialog).getByText("End date unknown")).toBeTruthy();
		expect(
			within(dialog).getByRole("button", { name: "Reactivate Fred Former" }),
		).toBeTruthy();
		expect(
			within(dialog).getByRole("button", { name: "Reactivate Gina Former" }),
		).toBeTruthy();
	});

	// protects=the busy row says "Reactivating…" and keeps focus, then focus moves to the next row;
	// fails_when=the busy button is disabled (drops focus) or focus falls to the container;
	// no_claim=real router invalidation (the harness re-renders by hand).
	it("shows Reactivating… and moves focus to the next row afterwards", async () => {
		const list = [
			{ id: "a", name: "Fred Former", endedAt: "2026-10-05" },
			{ id: "b", name: "Gina Former", endedAt: null },
		];
		let resolve: () => void = () => {};
		vi.mocked(setMemberStatus).mockReturnValue(
			new Promise<void>((r) => {
				resolve = r;
			}) as never,
		);
		await renderRoute([memberRow("Ada Active", "active")], true, list);
		fireEvent.click(screen.getByRole("button", { name: "Former members (2)" }));
		const dialog = await screen.findByRole("dialog");
		const first = within(dialog).getByRole("button", {
			name: "Reactivate Fred Former",
		});
		first.focus();
		fireEvent.click(first);
		await within(dialog).findByText("Reactivating…");
		expect(document.activeElement).toBe(
			within(dialog).getByRole("button", { name: "Reactivating Fred Former" }),
		);
		list.shift();
		await act(async () => {
			resolve();
			force?.();
		});
		await waitFor(() =>
			expect(document.activeElement).toBe(
				within(dialog).getByRole("button", { name: "Reactivate Gina Former" }),
			),
		);
	});
});

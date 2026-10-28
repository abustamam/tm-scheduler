// @vitest-environment jsdom
//
// End membership on the member profile (#1329): what the confirm says, that it
// stays open until the request settles, where focus goes after, and the end
// date beside the Former badge.
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
import { getMemberProfile } from "#/server/club";
import { listFormerMembers, setMemberStatus } from "#/server/members";
import { getMemberMentorships } from "#/server/mentorship";
import { getMemberOrientation } from "#/server/orientation";
import {
	getMemberEnrollments,
	listPathwayOptions,
} from "#/server/path-enrollment";
import { getMemberPathways } from "#/server/pathways-read";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/club", () => ({ getMemberProfile: vi.fn() }));
vi.mock("#/server/members", () => ({
	editMember: vi.fn(),
	listFormerMembers: vi.fn(),
	removeMember: vi.fn(),
	setMemberRole: vi.fn(),
	setMemberStatus: vi.fn(),
}));
vi.mock("#/server/path-enrollment", () => ({
	addMemberPath: vi.fn(),
	getMemberEnrollments: vi.fn(),
	listPathwayOptions: vi.fn(),
	removeMemberPath: vi.fn(),
}));
vi.mock("#/server/mentorship", () => ({
	createMentorship: vi.fn(),
	endMentorship: vi.fn(),
	getMemberMentorships: vi.fn(),
	setMentorshipFocus: vi.fn(),
}));
vi.mock("#/server/orientation", () => ({
	getMemberOrientation: vi.fn(),
	startOrientation: vi.fn(),
}));
vi.mock("#/server/pathways-read", () => ({ getMemberPathways: vi.fn() }));
vi.mock("#/server/progress-marks", () => ({
	markMemberProject: vi.fn(),
	unmarkMemberProject: vi.fn(),
}));
vi.mock("#/server/clubs", () => ({
	loadClubTimezoneSettings: vi.fn(async () => ({ timezone: "UTC", zones: [] })),
}));
vi.mock("#/server/speeches", () => ({
	archiveSpeech: vi.fn(),
	editSpeechFromLog: vi.fn(),
	rescheduleSpeech: vi.fn(),
}));
vi.mock("#/server/project-picker", () => ({ getProjectOptions: vi.fn() }));
vi.mock("#/server/slots", () => ({ updateSpeakerDetails: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { Route } from "./members.$id";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

let force: (() => void) | null = null;

/** `state` is read on every render, so a test can flip the status mid-flight. */
async function renderRoute(
	state: { status: "active" | "inactive" | "former"; endedAt?: string | null },
	opts: { clubRole?: "admin" | "member" } = {},
) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [
			{
				clubId: CLUB_ID,
				name: "Downtown Club",
				clubNumber: "123456",
				clubRole: opts.clubRole ?? "admin",
			},
		],
		activeClubId: CLUB_ID,
		officerPositions: [],
		authUser: { id: "viewer-user" },
		impersonating: null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockImplementation(
		() =>
			({
				member: {
					id: MEMBER_ID,
					name: "Ada Member",
					preferredName: null,
					phone: null,
					phoneRaw: null,
					email: null,
					officerPositions: [] as string[],
					userId: null,
					status: state.status,
					clubRole: "member" as const,
					createdAt: new Date("2024-01-15T00:00:00Z"),
					joinedAt: new Date("2024-01-15T00:00:00Z"),
					originalJoinDate: null,
				},
				endedAt: state.endedAt ?? null,
				speechLog: [],
				rolesServed: [],
				speeches: 0,
				pathways: [],
				unscheduledSpeeches: [],
				openSpeakerSlots: [],
				pathOptions: [],
				enrollments: [],
				speechLogTruncated: false,
				allSpeeches: false,
				now: new Date("2026-09-24T12:00:00Z").getTime(),
				timezone: "UTC",
				// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
			}) as any,
	);
	const Component = Route.options.component as () => React.ReactElement;
	function Harness() {
		const [, setN] = useState(0);
		force = () => setN((n) => n + 1);
		return <Component />;
	}
	await renderUnderMemoryRouter(<Harness />);
}

async function openEnd() {
	fireEvent.click(screen.getByRole("button", { name: "End membership" }));
	await screen.findByRole("heading", { name: "End Ada Member's membership?" });
}

describe("End membership confirm (#1329)", () => {
	// protects=the confirm names role release, office closure and that Reactivate restores neither;
	// fails_when=the copy goes back to "They leave the roster; their history stays.";
	// no_claim=what the server does (members-logic integration tests).
	it("names everything End does", async () => {
		await renderRoute({ status: "active" });
		await openEnd();
		const body = screen.getByRole("dialog").textContent ?? "";
		expect(body).toMatch(/upcoming roles are released/);
		expect(body).toMatch(
			/office they hold is closed and any admin access they have ends/,
		);
		expect(body).toMatch(/Reactivating them restores neither/);
	});

	// protects=the dialog stays open and says "Ending…" until the request settles;
	// fails_when=the dialog closes before the request resolves;
	// no_claim=the toast.
	it("stays open and shows Ending… while the request is pending", async () => {
		let resolve: () => void = () => {};
		vi.mocked(setMemberStatus).mockReturnValue(
			new Promise<void>((r) => {
				resolve = r;
			}) as never,
		);
		await renderRoute({ status: "active" });
		await openEnd();
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "End membership",
			}),
		);
		expect(await screen.findByRole("button", { name: "Ending…" })).toBeTruthy();
		expect(screen.getByRole("dialog")).toBeTruthy();
		await act(async () => resolve());
	});

	// protects=a refusal shows inside the open dialog, not only as a toast;
	// fails_when=the error is toast-only or the dialog closes on failure;
	// no_claim=the refusal text itself (server-owned).
	it("shows a failure inline and keeps the dialog open", async () => {
		vi.mocked(setMemberStatus).mockRejectedValue(new Error("Not allowed."));
		await renderRoute({ status: "active" });
		await openEnd();
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "End membership",
			}),
		);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("Not allowed.");
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	// protects=focus lands on Reactivate once End succeeds, not on the page;
	// fails_when=the End button's unmount drops focus to the body;
	// no_claim=real router invalidation (the harness re-renders by hand).
	it("moves focus to Reactivate after a successful End", async () => {
		const state = { status: "active" as "active" | "former" };
		vi.mocked(setMemberStatus).mockImplementation((async () => {
			state.status = "former";
			act(() => force?.());
		}) as never);
		await renderRoute(state);
		await openEnd();
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "End membership",
			}),
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Reactivate" }),
			),
		);
	});
});

describe("Former profile (#1329)", () => {
	// protects=the end date shows beside the Former badge;
	// fails_when=endedAt is not rendered, or is shown raw;
	// no_claim=that the loader fetches it (admin-only server fn).
	it("shows Ended <date> beside the badge", async () => {
		await renderRoute({ status: "former", endedAt: "2026-10-05" });
		expect(screen.getByText("Former")).toBeTruthy();
		expect(screen.getByText("Ended Oct 5, 2026")).toBeTruthy();
	});

	it("shows no end date when none is known", async () => {
		await renderRoute({ status: "former", endedAt: null });
		expect(screen.queryByText(/^Ended /)).toBeNull();
	});

	// protects=the withheld-Pathways sentence names the member's own status;
	// fails_when=an inactive member is called former, or the reverse;
	// no_claim=the server's withholding.
	it.each([
		["inactive", "inactive"],
		["former", "former"],
	] as const)("calls a %s member %s in the Pathways note", async (status, word) => {
		await renderRoute({ status }, { clubRole: "member" });
		expect(
			screen.getByText(`Pathways progress isn't shown for ${word} members.`),
		).toBeTruthy();
	});
});

describe("Former profile loader (#1329)", () => {
	const loader = Route.options.loader as unknown as (a: unknown) => Promise<{
		endedAt: string | null;
	}>;
	const OTHER_ID = "33333333-3333-4333-8333-333333333333";

	function run(opts: {
		clubRole?: "admin" | "member";
		impersonating?: { mode: "read_only"; clubId: string } | null;
		status?: "former" | "active";
	}) {
		vi.mocked(getMemberProfile).mockResolvedValue({
			member: { id: MEMBER_ID, status: opts.status ?? "former" },
		} as never);
		vi.mocked(getMemberPathways).mockResolvedValue([] as never);
		vi.mocked(listPathwayOptions).mockResolvedValue([] as never);
		vi.mocked(getMemberEnrollments).mockResolvedValue([] as never);
		vi.mocked(getMemberOrientation).mockResolvedValue(null as never);
		vi.mocked(getMemberMentorships).mockResolvedValue(null as never);
		return loader({
			params: { id: MEMBER_ID },
			deps: { allSpeeches: false },
			context: {
				activeClubId: CLUB_ID,
				clubs: [
					{
						clubId: CLUB_ID,
						name: "Downtown Club",
						clubNumber: "123456",
						clubRole: opts.clubRole ?? "admin",
					},
				],
				officerPositions: [],
				impersonating: opts.impersonating ?? null,
			},
		});
	}

	// protects=the end date is the row whose id matches the route param, not the first row;
	// fails_when=the loader takes rows[0] or matches by name;
	// no_claim=the server's list.
	it("picks the former-members row by params.id", async () => {
		vi.mocked(listFormerMembers).mockResolvedValue([
			{ id: OTHER_ID, name: "Other", endedAt: "2025-01-01" },
			{ id: MEMBER_ID, name: "Ada Member", endedAt: "2026-10-05" },
		] as never);
		expect((await run({})).endedAt).toBe("2026-10-05");
	});

	// protects=a viewer the admin-only list refuses never makes the call;
	// fails_when=the loader calls listFormerMembers for a non-admin, a view-as session, or a non-former member;
	// no_claim=the server's own refusal.
	it.each([
		["a non-admin", { clubRole: "member" as const }],
		[
			"a view-as session",
			{ impersonating: { mode: "read_only" as const, clubId: CLUB_ID } },
		],
		["an active member's profile", { status: "active" as const }],
	])("does not call listFormerMembers for %s", async (_label, opts) => {
		const result = await run(opts);
		expect(listFormerMembers).not.toHaveBeenCalled();
		expect(result.endedAt).toBeNull();
	});

	// protects=a failing list gives no date and does not fail the page;
	// fails_when=the rejection propagates out of the loader;
	// no_claim=that the failure is surfaced anywhere.
	it("yields no date, not a failed loader, when the list rejects", async () => {
		vi.mocked(listFormerMembers).mockRejectedValue(new Error("boom"));
		expect((await run({})).endedAt).toBeNull();
	});
});

// @vitest-environment jsdom
//
// The status controls on the member profile (#1326). Each test fails when its
// change is reverted:
//   - "Mark inactive instead" is offered for an ACTIVE member only;
//   - End membership is hidden for a linked (signed-in) account;
//   - editing a FORMER member sends no `officerPositions` (the server reads an
//     omitted key as "leave terms alone", and `[]` as "close every office").
// Harness follows `members.$id.test.tsx` (server-fn modules mocked, route
// component rendered directly); that file is not imported, it would run its tests.
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pastAgendaRemoveRefusal } from "#/lib/member-remove";
import { editMember, removeMember } from "#/server/members";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/club", () => ({ getMemberProfile: vi.fn() }));
vi.mock("#/server/members", () => ({
	editMember: vi.fn(),
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

async function renderRoute(over: Record<string, unknown> = {}) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [
			{
				clubId: CLUB_ID,
				name: "Downtown Club",
				clubNumber: "123456",
				clubRole: "admin",
			},
		],
		activeClubId: CLUB_ID,
		officerPositions: [],
		authUser: { id: "viewer-user" },
		impersonating: null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		member: {
			id: MEMBER_ID,
			name: "Ada Member",
			preferredName: null,
			phone: "+14155552671",
			phoneRaw: "415-555-2671",
			email: "ada@example.com",
			officerPositions: [] as string[],
			userId: null,
			status: "active" as const,
			clubRole: "member" as const,
			createdAt: new Date("2024-01-15T00:00:00Z"),
			joinedAt: new Date("2024-01-15T00:00:00Z"),
			originalJoinDate: null,
			...over,
		},
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
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

/** Open Remove and let the server refuse it, which is what offers the alternative. */
async function refuseRemove() {
	vi.mocked(removeMember).mockRejectedValue(
		new Error(pastAgendaRemoveRefusal("Ada Member")),
	);
	fireEvent.click(screen.getByRole("button", { name: "Remove" }));
	await screen.findByRole("heading", { name: "Remove Ada Member?" });
	fireEvent.click(screen.getByRole("button", { name: "Remove member" }));
	await screen.findByRole("alert");
}

describe("member profile status controls (#1326)", () => {
	it("offers Mark inactive instead for an active member", async () => {
		await renderRoute({ status: "active" });
		await refuseRemove();
		expect(
			screen.getByRole("button", { name: "Mark inactive instead" }),
		).toBeTruthy();
	});

	it("does not offer Mark inactive instead for an inactive member", async () => {
		await renderRoute({ status: "inactive" });
		await refuseRemove();
		expect(
			screen.queryByRole("button", { name: "Mark inactive instead" }),
		).toBeNull();
	});

	it("does not offer Mark inactive instead for a former member", async () => {
		await renderRoute({ status: "former" });
		await refuseRemove();
		expect(
			screen.queryByRole("button", { name: "Mark inactive instead" }),
		).toBeNull();
	});

	it("shows End membership for an unlinked roster member", async () => {
		await renderRoute({ status: "active", userId: null });
		expect(screen.getByRole("button", { name: "End membership" })).toBeTruthy();
	});

	it("hides End membership for a linked account", async () => {
		await renderRoute({ status: "active", userId: "user-1" });
		expect(screen.queryByRole("button", { name: "End membership" })).toBeNull();
	});

	async function saveEdit() {
		vi.mocked(editMember).mockResolvedValue({
			ok: true,
			rosterConflict: null,
			emailRefused: null,
			// biome-ignore lint/suspicious/noExplicitAny: server-fn return stub
		} as any);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		await screen.findByLabelText("Phone");
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await vi.waitFor(() => expect(editMember).toHaveBeenCalled());
		return (
			vi.mocked(editMember).mock.calls[0]?.[0] as {
				data: Record<string, unknown>;
			}
		).data;
	}

	it("editing a former member sends no officerPositions", async () => {
		await renderRoute({ status: "former" });
		const data = await saveEdit();
		expect(Object.hasOwn(data, "officerPositions")).toBe(false);
	});

	it("editing an active member sends the full office set", async () => {
		await renderRoute({ status: "active" });
		const data = await saveEdit();
		expect(data.officerPositions).toEqual([]);
	});
});

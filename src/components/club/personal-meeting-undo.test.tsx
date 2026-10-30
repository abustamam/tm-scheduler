// @vitest-environment jsdom

// Undo on the personal page's attendance toasts (#1427). Only a session CHANGING
// an earlier answer gets one, and a decline that freed roles does not.

import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/availability", () => ({
	markUnavailableReleasing: vi.fn(),
}));
vi.mock("#/server/attendance-plan", () => ({
	setPlannedAttendance: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const { markUnavailableReleasing } = await import("#/server/availability");
const { setPlannedAttendance } = await import("#/server/attendance-plan");
const { toast } = await import("sonner");
const { PersonalMeetingBody } = await import("./personal-meeting-body");
type View = import("#/server/personal-meeting").PersonalMeetingView;

afterEach(cleanup);
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(setPlannedAttendance).mockResolvedValue({
		ok: true,
		changed: true,
		released: 0,
		confirmedRoles: [],
	} as never);
});

function view(planStatus: View["planStatus"]): View {
	return {
		club: { id: "c1", name: "Club", timezone: "America/Chicago" },
		meeting: {
			id: "22222222-2222-4222-8222-222222222222",
			scheduledAt: new Date(Date.now() + 7 * 86_400_000),
			lengthMinutes: 90,
			theme: null,
			wordOfTheDay: null,
			tableTopicsNotes: null,
			status: "scheduled",
		},
		member: { id: "33333333-3333-4333-8333-333333333333", name: "Marcus" },
		roles: [],
		planStatus,
	} as unknown as View;
}

async function renderBody(v: View, canRepick: boolean) {
	const root = createRootRoute({
		component: () => (
			<PersonalMeetingBody
				view={v}
				clubId="club"
				meetingId="2026-09-05"
				onChanged={async () => {}}
				onNotYou={() => {}}
				canRepick={canRepick}
				roleGuides={[]}
			/>
		),
	});
	const router = createRouter({
		routeTree: root,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

type Opts = { action?: { label: string; onClick: () => void } } | undefined;
const lastToastOpts = (): Opts => {
	const calls = vi.mocked(toast.success).mock.calls;
	return calls[calls.length - 1][1] as Opts;
};

async function decline() {
	await userEvent.click(
		await screen.findByRole("button", { name: "No, I can't" }),
	);
	await userEvent.click(
		await screen.findByRole("button", { name: "Yes, I can't make it" }),
	);
	await waitFor(() => expect(toast.success).toHaveBeenCalled());
}

describe("PersonalMeetingBody: Undo on an answer (#1427)", () => {
	it("a session changing coming to not coming (no roles freed) gets Undo that writes coming", async () => {
		// protects=Undo is offered on a changed, role-free decline and writes the
		//   PREVIOUS answer ("coming") with no release or confirm flag
		// fails_when=no action, or Undo writes not_coming / sets a release flag
		// no_claim=the server accepting the write (stubbed)
		vi.mocked(markUnavailableReleasing).mockResolvedValue({
			ok: true,
			released: 0,
		} as never);
		await renderBody(view("coming"), false);
		await decline();
		const action = lastToastOpts()?.action;
		expect(action?.label).toBe("Undo");
		action?.onClick();
		await waitFor(() => expect(setPlannedAttendance).toHaveBeenCalledTimes(1));
		expect(setPlannedAttendance).toHaveBeenCalledWith({
			data: {
				memberId: "33333333-3333-4333-8333-333333333333",
				meetingId: "22222222-2222-4222-8222-222222222222",
				status: "coming",
			},
		});
	});

	it("a decline that freed roles gets no Undo", async () => {
		// protects=released > 0 means no Undo (it would need several re-claims)
		// fails_when=the released count is ignored
		// no_claim=the toast wording
		vi.mocked(markUnavailableReleasing).mockResolvedValue({
			ok: true,
			released: 2,
		} as never);
		await renderBody(view("coming"), false);
		await decline();
		expect(lastToastOpts()?.action).toBeUndefined();
	});

	it("a first answer gets no Undo", async () => {
		// protects=no previous answer, nothing to restore
		// fails_when=Undo is offered with previous null
		// no_claim=nothing
		vi.mocked(markUnavailableReleasing).mockResolvedValue({
			ok: true,
			released: 0,
		} as never);
		await renderBody(view(null), false);
		await decline();
		expect(lastToastOpts()?.action).toBeUndefined();
	});

	it("an anonymous (non-session) decline gets no Undo", async () => {
		// protects=a roster-pick viewer's decline has no Undo (and writes through
		//   setPlannedAttendance, not the releasing writer)
		// fails_when=Undo ignores the session
		// no_claim=that the server refuses an asserted change (it does, elsewhere)
		await renderBody(view(null), true);
		await decline();
		expect(markUnavailableReleasing).not.toHaveBeenCalled();
		expect(lastToastOpts()?.action).toBeUndefined();
	});

	it("a session changing not coming to coming gets Undo that writes not coming", async () => {
		// protects=the "coming" arm offers Undo only over a changed not_coming, and
		//   Undo restores not_coming without releasing anything
		// fails_when=no action, or the restored status/flags are wrong
		// no_claim=the server accepting the write (stubbed)
		await renderBody(view("not_coming"), false);
		await userEvent.click(
			await screen.findByRole("button", { name: /Yes, I'm coming/ }),
		);
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		const action = lastToastOpts()?.action;
		expect(action?.label).toBe("Undo");
		vi.mocked(setPlannedAttendance).mockClear();
		action?.onClick();
		await waitFor(() => expect(setPlannedAttendance).toHaveBeenCalledTimes(1));
		expect(setPlannedAttendance).toHaveBeenCalledWith({
			data: {
				memberId: "33333333-3333-4333-8333-333333333333",
				meetingId: "22222222-2222-4222-8222-222222222222",
				status: "not_coming",
			},
		});
	});
});

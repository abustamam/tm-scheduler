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
const { PersonalMeetingBody } = await import(
	"#/components/club/personal-meeting-body"
);
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

const onChanged = vi.fn(async () => {});

async function renderBody(v: View, canRepick: boolean) {
	const root = createRootRoute({
		component: () => (
			<PersonalMeetingBody
				view={v}
				clubId="club"
				meetingId="2026-09-05"
				onChanged={onChanged}
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

async function comeBack() {
	await userEvent.click(
		await screen.findByRole("button", { name: /Yes, I'm coming/ }),
	);
	await waitFor(() => expect(toast.success).toHaveBeenCalled());
}

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

	it("an anonymous viewer re-sending coming to confirm a role gets no Undo", async () => {
		// protects=the one path where a roster-pick viewer holding an answer can
		//   still write (the same-answer confirm button): changed may be true, and
		//   it still gets no Undo. NOTE: an anonymous change from not_coming or a
		//   decline over "coming" has no button at all (canAnswer), so the
		//   `canRelease` term on the coming arm is defence in depth with no
		//   reachable render; the mutation check reports it as such.
		// fails_when=the toast offers Undo to an anonymous viewer
		// no_claim=that the server refuses an asserted change (it does, elsewhere)
		const v = view("coming");
		(v as unknown as { roles: unknown[] }).roles = [
			{ slotId: "s1", roleName: "Timer", status: "claimed" },
		];
		await renderBody(v, true);
		await userEvent.click(
			await screen.findByRole("button", { name: /I'll be there/ }),
		);
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		expect(setPlannedAttendance).toHaveBeenCalledTimes(1);
		expect(lastToastOpts()?.action).toBeUndefined();
	});

	it("an anonymous first decline gets no Undo and does not use the releasing writer", async () => {
		// protects=a roster-pick viewer's decline goes through setPlannedAttendance
		//   and toasts with no action
		// fails_when=the anonymous arm is routed through the releasing writer
		// no_claim=nothing
		await renderBody(view(null), true);
		await decline();
		expect(markUnavailableReleasing).not.toHaveBeenCalled();
		expect(lastToastOpts()?.action).toBeUndefined();
	});

	it("a first coming answer, or a repeat of coming, gets no Undo", async () => {
		// protects=Undo on the coming arm needs a previous NOT-coming answer
		// fails_when=previous is not compared, so a first answer or a repeat of
		//   coming (changed:true from a stale view) offers Undo writing not_coming
		// no_claim=nothing
		await renderBody(view(null), false);
		await comeBack();
		expect(lastToastOpts()?.action).toBeUndefined();
		cleanup();
		vi.mocked(toast.success).mockClear();
		await renderBody(view("coming"), false);
		await comeBack();
		expect(lastToastOpts()?.action).toBeUndefined();
	});

	it("a coming answer that changed nothing gets no Undo", async () => {
		// protects=changed:false (already coming server-side) means nothing to undo
		// fails_when=the changed flag is ignored
		// no_claim=nothing
		vi.mocked(setPlannedAttendance).mockResolvedValue({
			ok: true,
			changed: false,
			released: 0,
			confirmedRoles: [],
		} as never);
		await renderBody(view("not_coming"), false);
		await comeBack();
		expect(lastToastOpts()?.action).toBeUndefined();
	});

	it("a coming switch that confirmed held roles gets no Undo", async () => {
		// protects=Undo is never offered when it could not reverse the confirm flip
		// fails_when=the confirmedRoles gate is dropped
		// no_claim=the toast wording
		vi.mocked(setPlannedAttendance).mockResolvedValue({
			ok: true,
			changed: true,
			released: 0,
			confirmedRoles: ["Timer"],
		} as never);
		await renderBody(view("not_coming"), false);
		await comeBack();
		expect(lastToastOpts()?.action).toBeUndefined();
	});

	it("Undo success toasts, refreshes the page, and gives the coming arm the duty duration", async () => {
		// protects=success path: "Back to ..." toast, onChanged refresh, and the
		//   coming-arm toast using DUTY_TOAST_MS like the other arms
		// fails_when=no refresh after Undo, or the duration dropped
		// no_claim=server acceptance (stubbed)
		await renderBody(view("not_coming"), false);
		await comeBack();
		expect((lastToastOpts() as { duration?: number }).duration).toBe(10_000);
		onChanged.mockClear();
		lastToastOpts()?.action?.onClick();
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
		expect(toast.success).toHaveBeenCalledWith("Back to not coming.");
	});

	it("a failed Undo shows the write-error toast and no success", async () => {
		// protects=undoAnswer's catch: a rejected write says "Couldn't undo that."
		// fails_when=the rejection is swallowed or a success toast is shown
		// no_claim=Error-message wording (non-Error rejection uses the fallback)
		vi.mocked(markUnavailableReleasing).mockResolvedValue({
			ok: true,
			released: 0,
		} as never);
		await renderBody(view("coming"), false);
		await decline();
		vi.mocked(setPlannedAttendance).mockRejectedValue("nope");
		onChanged.mockClear();
		lastToastOpts()?.action?.onClick();
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("Couldn't undo that."),
		);
		expect(toast.success).not.toHaveBeenCalledWith("Back to coming.");
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("a double tap on Undo writes once", async () => {
		// protects=undoAnswer's in-flight guard
		// fails_when=two taps send two writes
		// no_claim=nothing
		vi.mocked(markUnavailableReleasing).mockResolvedValue({
			ok: true,
			released: 0,
		} as never);
		await renderBody(view("coming"), false);
		await decline();
		let release: () => void = () => {};
		vi.mocked(setPlannedAttendance).mockReturnValue(
			new Promise((r) => {
				release = () => r({ ok: true } as never);
			}),
		);
		const action = lastToastOpts()?.action;
		onChanged.mockClear();
		action?.onClick();
		action?.onClick();
		release();
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(setPlannedAttendance).toHaveBeenCalledTimes(1);
	});

	it("a session changing not coming to coming gets Undo that writes not coming", async () => {
		// protects=the "coming" arm offers Undo only over a changed not_coming, and
		//   Undo restores not_coming without releasing anything
		// fails_when=no action, or the restored status/flags are wrong
		// no_claim=the server accepting the write (stubbed)
		await renderBody(view("not_coming"), false);
		await comeBack();
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

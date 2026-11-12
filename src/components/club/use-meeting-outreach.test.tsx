// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingOutreach } from "./use-meeting-outreach";

const invalidate = vi.fn(async () => {});
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));
const toastSuccess = vi.fn();
const toastMessage = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => toastSuccess(...a),
		message: (...a: unknown[]) => toastMessage(...a),
	},
}));
const showWriteError = vi.fn();
vi.mock("#/components/write-error-toast", () => ({
	showWriteError: (...a: unknown[]) => showWriteError(...a),
}));
const setPlannedAttendance = vi.fn(async (_a: unknown) => ({ released: 0 }));
const clearPlannedAttendance = vi.fn(async (_a: unknown) => ({
	cleared: true,
}));
vi.mock("#/server/attendance-plan", () => ({
	setPlannedAttendance: (a: unknown) => setPlannedAttendance(a),
	clearPlannedAttendance: (a: unknown) => clearPlannedAttendance(a),
}));
vi.mock("#/server/lineup-blast", () => ({
	getLineupBlastAccess: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("#/server/meetings", () => ({}));
const setContacted = vi.fn(async (_a: unknown) => ({}));
const clearContacted = vi.fn(async (_a: unknown) => ({}));
vi.mock("#/server/outreach", () => ({
	setContacted: (a: unknown) => setContacted(a),
	clearContacted: (a: unknown) => clearContacted(a),
}));

const base = {
	meetingId: "m1",
	clubUuid: "c1",
	myId: "me" as string | null,
	isSignedIn: true,
	isTmod: false,
	holdsRole: false,
	cancelled: false,
	previewAsMember: false,
	effectiveCanManage: false,
	needsTmodPlan: false,
	tmodPlanKey: ["tmod-plan", "m1", "me"] as const,
	effectivePlan: [] as never,
	answeredRungs: [] as never,
	panelRosterForMode: [{ id: "a", name: "Ann" }],
	heldRolesByMember: {},
	declineFreesRoles: () => false,
};
let qc: QueryClient;
function setup(over: Record<string, unknown> = {}) {
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return renderHook(() => useMeetingOutreach({ ...base, ...over } as never), {
		wrapper,
	});
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("useMeetingOutreach", () => {
	it("a non-officer's write carries their own id as the actor claim; an officer's does not", async () => {
		const member = setup();
		await act(() => member.result.current.writeRung("me", "coming" as never));
		expect(setPlannedAttendance).toHaveBeenLastCalledWith({
			data: expect.objectContaining({
				memberId: "me",
				meetingId: "m1",
				status: "coming",
				via: "manual",
				actorMemberId: "me",
			}),
		});
		const officer = setup({ effectiveCanManage: true });
		await act(() => officer.result.current.writeRung("a", "coming" as never));
		const data = (
			setPlannedAttendance.mock.calls.at(-1)?.[0] as {
				data: Record<string, unknown>;
			}
		).data;
		expect(data.actorMemberId).toBeUndefined();
	});

	// protects=answering Coming for yourself sends confirmHeldRoles and the toast
	// names what was confirmed, in the shared copy; fails_when=the flag is
	// dropped, the toast loses the role names or the shared sentence; no_claim=
	// the server confirming anything (setPlannedAttendance is stubbed).
	it("marking YOURSELF coming sends confirmHeldRoles and names what was confirmed (#1612)", async () => {
		setPlannedAttendance.mockResolvedValueOnce({
			released: 0,
			confirmedRoles: ["Timer", "Ah-Counter"],
		} as never);
		const { result } = setup();
		await act(() => result.current.writeRung("me", "coming" as never));
		expect(setPlannedAttendance).toHaveBeenLastCalledWith({
			data: expect.objectContaining({ memberId: "me", confirmHeldRoles: true }),
		});
		expect(toastSuccess).toHaveBeenCalledWith(
			"Great, you're confirmed as Timer and Ah-Counter. See you there.",
		);
	});

	// protects=the "Your jobs" card stops offering Confirm for a role the strip
	// just confirmed; fails_when=the ["personal-meeting"] invalidation is dropped
	// or fires when nothing was confirmed; no_claim=the card's own refetch.
	it("confirming roles from the strip invalidates the personal-meeting query; confirming none does not (#1612)", async () => {
		setPlannedAttendance.mockResolvedValueOnce({
			released: 0,
			confirmedRoles: ["Timer"],
		} as never);
		const { result } = setup();
		const spy = vi.spyOn(qc, "invalidateQueries");
		await act(() => result.current.writeRung("me", "coming" as never));
		expect(spy).toHaveBeenCalledWith({ queryKey: ["personal-meeting"] });
		spy.mockClear();
		setPlannedAttendance.mockResolvedValueOnce({
			released: 0,
			confirmedRoles: [],
		} as never);
		await act(() => result.current.writeRung("me", "coming" as never));
		expect(spy).not.toHaveBeenCalledWith({ queryKey: ["personal-meeting"] });
	});

	// protects=an officer's tap for someone else sends no confirm flag and
	// confirms nothing; fails_when=the flag leaks to another member's write;
	// no_claim=the server ignoring the flag unless actor == subject.
	it("marking ANOTHER member coming (an officer) sends no confirm flag, and says nothing (#1612)", async () => {
		const { result } = setup({ effectiveCanManage: true });
		await act(() => result.current.writeRung("a", "coming" as never));
		const data = (
			setPlannedAttendance.mock.calls.at(-1)?.[0] as {
				data: Record<string, unknown>;
			}
		).data;
		expect(data).not.toHaveProperty("confirmHeldRoles");
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	// protects=declining never asks to confirm roles; fails_when=the flag is
	// sent with not_coming; no_claim=the decline's release-roles behaviour.
	it("marking yourself not coming sends no confirm flag (#1612)", async () => {
		const { result } = setup({ declineFreesRoles: () => false });
		await act(() => result.current.writeRung("me", "not_coming" as never));
		const p = result.current.pendingDecline as never;
		await act(() => result.current.confirmDecline(p));
		const data = (
			setPlannedAttendance.mock.calls.at(-1)?.[0] as {
				data: Record<string, unknown>;
			}
		).data;
		expect(data).not.toHaveProperty("confirmHeldRoles");
	});

	it("clearing a rung calls the clear write, not the set write", async () => {
		const { result } = setup();
		await act(() => result.current.writeRung("me", null));
		expect(clearPlannedAttendance).toHaveBeenCalledWith({
			data: { memberId: "me", meetingId: "m1", actorMemberId: "me" },
		});
		expect(setPlannedAttendance).not.toHaveBeenCalled();
	});

	it("Not coming opens the decline dialog and writes nothing until confirmed", async () => {
		const { result } = setup({
			heldRolesByMember: { a: { name: "Ann", labels: ["Timer"] } },
			declineFreesRoles: () => true,
		});
		await act(() => result.current.writeRung("a", "not_coming" as never));
		expect(setPlannedAttendance).not.toHaveBeenCalled();
		expect(result.current.pendingDecline).toMatchObject({
			memberId: "a",
			name: "Ann",
			roleLabels: ["Timer"],
			willRelease: true,
			self: false,
		});
		const p = result.current.pendingDecline as never;
		await act(() => result.current.confirmDecline(p));
		expect(setPlannedAttendance).toHaveBeenCalledWith({
			data: expect.objectContaining({
				memberId: "a",
				status: "not_coming",
				releaseHeldRoles: true,
			}),
		});
		expect(result.current.pendingDecline).toBeNull();
		expect(result.current.declineBusy).toBe(false);
	});

	it("drops the release flag when the viewer's decline would not free roles", async () => {
		const { result } = setup({ declineFreesRoles: () => false });
		await act(() => result.current.writeRung("a", "not_coming" as never));
		const p = result.current.pendingDecline as never;
		await act(() => result.current.confirmDecline(p));
		expect(setPlannedAttendance).toHaveBeenCalledWith({
			data: expect.objectContaining({ releaseHeldRoles: false }),
		});
	});

	it("rolls an optimistic override back to the previous rung when the write fails", async () => {
		setPlannedAttendance.mockRejectedValueOnce(new Error("no"));
		const { result } = setup({
			effectivePlan: [{ memberId: "me", status: "maybe" }],
		});
		await act(() => result.current.writeRung("me", "coming" as never));
		expect(showWriteError).toHaveBeenCalledTimes(1);
		expect(result.current.rungOverride.me).toBe("maybe");
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("refreshes the router, and the Toastmaster's query only when one is in play", async () => {
		const spy = () => vi.spyOn(qc, "invalidateQueries");
		const plain = setup();
		const s1 = spy();
		await act(() => plain.result.current.writeRung("me", "coming" as never));
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(s1).not.toHaveBeenCalled();
		const tmod = setup({ needsTmodPlan: true });
		const s2 = spy();
		await act(() => tmod.result.current.writeRung("me", "coming" as never));
		expect(s2).toHaveBeenCalledWith({ queryKey: ["tmod-plan", "m1", "me"] });
	});

	it("toasts a refused clear of another member's answered row", async () => {
		clearPlannedAttendance.mockResolvedValueOnce({ cleared: false });
		const { result } = setup({
			effectiveCanManage: true,
			effectivePlan: [{ memberId: "a", status: "coming" }],
		});
		await act(() => result.current.writeRung("a", null));
		expect(toastMessage).toHaveBeenCalledTimes(1);
	});

	it("markAsked nudges an unanswered member and leaves an answered one alone", async () => {
		const open = setup();
		await act(() => open.result.current.markAsked("a"));
		expect(setPlannedAttendance).toHaveBeenCalledWith({
			data: expect.objectContaining({ status: "reached_out", via: "nudge" }),
		});
		setPlannedAttendance.mockClear();
		const answered = setup({
			effectivePlan: [{ memberId: "a", status: "coming" }],
		});
		await act(() => answered.result.current.markAsked("a"));
		expect(setPlannedAttendance).not.toHaveBeenCalled();
	});

	it("the strip reads the public array and hides a reached_out rung", () => {
		const answered = setup({
			answeredRungs: [{ memberId: "me", status: "coming" }],
		});
		expect(answered.result.current.myEffectiveStatus).toBe("coming");
		const reached = setup({
			answeredRungs: [{ memberId: "me", status: "reached_out" }],
		});
		expect(reached.result.current.myEffectiveStatus).toBeNull();
	});

	it("setMyStatus writes the viewer's own rung and releases the busy flag; no viewer, no write", async () => {
		const { result } = setup();
		await act(() => result.current.setMyStatus("coming" as never));
		expect(setPlannedAttendance).toHaveBeenCalledWith({
			data: expect.objectContaining({ memberId: "me" }),
		});
		expect(result.current.myStatusBusy).toBe(false);
		setPlannedAttendance.mockClear();
		const anon = setup({ myId: null });
		await act(() => anon.result.current.setMyStatus("coming" as never));
		expect(setPlannedAttendance).not.toHaveBeenCalled();
	});

	it("marks and unmarks a member as contacted for this meeting and club, then refreshes", async () => {
		const { result } = setup();
		await act(() => result.current.onContacted("a", "nudge"));
		expect(setContacted).toHaveBeenCalledWith({
			data: { memberId: "a", meetingId: "m1", clubId: "c1", via: "nudge" },
		});
		await act(() => result.current.onUncontacted("a"));
		expect(clearContacted).toHaveBeenCalledWith({
			data: { memberId: "a", meetingId: "m1", clubId: "c1" },
		});
		expect(invalidate).toHaveBeenCalledTimes(2);
	});

	it("reports a failed contacted write instead of refreshing", async () => {
		setContacted.mockRejectedValueOnce(new Error("x"));
		const { result } = setup();
		await act(() => result.current.onContacted("a", "manual"));
		expect(showWriteError).toHaveBeenCalledTimes(1);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("a cancelled meeting never offers the lineup blast", () => {
		const { result } = setup({ effectiveCanManage: true, cancelled: true });
		expect(result.current.canLineupBlast).toBe(false);
		expect(
			setup({ effectiveCanManage: true }).result.current.canLineupBlast,
		).toBe(true);
	});
});

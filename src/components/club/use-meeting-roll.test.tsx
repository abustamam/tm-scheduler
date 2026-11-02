// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingRoll } from "./use-meeting-roll";

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
	toast: { success: (...a: unknown[]) => toastSuccess(...a) },
}));
const setAttendance = vi.fn(async (_a: unknown) => ({
	released: [] as { label: string }[],
	welcomeBack: null as null | { lastPresentAt: string },
}));
const addMinutesGuest = vi.fn(async (_a: unknown) => ({}));
const removeMinutesGuest = vi.fn(async (_a: unknown) => ({}));
vi.mock("#/server/minutes", () => ({
	setAttendance: (a: unknown) => setAttendance(a),
	addMinutesGuest: (a: unknown) => addMinutesGuest(a),
	removeMinutesGuest: (a: unknown) => removeMinutesGuest(a),
}));
const getTmodPanelData = vi.fn(async (_a: unknown) => ({
	plan: [{ memberId: "x" }],
	roster: [{ id: "x", name: "Xan" }],
}));
vi.mock("#/server/meetings", () => ({
	getTmodPanelData: (a: unknown) => getTmodPanelData(a),
}));
vi.mock("#/server/guest-pipeline", () => ({
	getGuestPipeline: vi.fn(async () => []),
}));

type Op = () => Promise<unknown>;
const mutate = vi.fn(async (run: Op, _op: () => unknown) => run());
const offlineMinutes = {
	mutate,
	opMeta: () => ({ opId: "op1" }),
	snapshot: null,
	queue: [],
} as never;

const base = {
	meetingId: "m1",
	clubUuid: "c1",
	timezone: "UTC",
	online: true,
	myId: "me",
	effectiveCanManage: true,
	minutes: { data: null } as never,
	offlineMinutes,
	loaderRoster: [{ id: "a", name: "Ann" }] as never,
	roster: [{ id: "a", name: "Ann" }],
	plan: [{ memberId: "a" }] as never,
	guestRsvps: [{ guestId: "g1", name: "Gus" }] as never,
	clubGuests: [] as never,
	needsTmodPlan: false,
	panelMode: "roll" as const,
	showRollPanel: true,
	attendanceDefaultMode: "in_person" as never,
	heldRolesByMember: {} as never,
	heldRoleLinesByMember: {},
};
function setup(over: Record<string, unknown> = {}) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return renderHook(() => useMeetingRoll({ ...base, ...over } as never), {
		wrapper,
	});
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("useMeetingRoll", () => {
	it("writes presence through the offline queue with the meeting and member", async () => {
		const { result } = setup();
		await act(() => result.current.writeAttendance("a", "present"));
		expect(mutate).toHaveBeenCalledTimes(1);
		expect(setAttendance).toHaveBeenCalledWith({
			data: expect.objectContaining({
				meetingId: "m1",
				memberId: "a",
				status: "present",
			}),
		});
		const op = (mutate.mock.calls[0]?.[1] as () => unknown)();
		expect(op).toMatchObject({
			type: "setAttendance",
			memberId: "a",
			status: "present",
		});
	});

	it("Absent on a role-holder opens the dialog and writes nothing", async () => {
		const { result } = setup({
			heldRolesByMember: { a: { name: "Ann", labels: ["Timer 1"] } },
			heldRoleLinesByMember: { a: [{ slotId: "s1", label: "Timer 1" }] },
		});
		await act(() => result.current.writeAttendance("a", "absent"));
		expect(setAttendance).not.toHaveBeenCalled();
		expect(result.current.pendingAbsent).toMatchObject({
			memberId: "a",
			name: "Ann",
		});
		act(() => result.current.cancelAbsent());
		expect(result.current.pendingAbsent).toBeNull();
	});

	it("Absent with no roles falls through to the direct write", async () => {
		const { result } = setup();
		await act(() => result.current.writeAttendance("a", "absent"));
		expect(setAttendance).toHaveBeenCalledTimes(1);
		expect(result.current.pendingAbsent).toBeNull();
	});

	it("Release roles sends only the listed slot ids; Keep sends none", async () => {
		const { result } = setup();
		const p = {
			memberId: "a",
			name: "Ann",
			roles: [{ slotId: "s1", label: "Timer 1" }],
		} as never;
		await act(() => result.current.confirmAbsent(p, true));
		expect(setAttendance).toHaveBeenLastCalledWith({
			data: expect.objectContaining({
				releaseHeldRoles: true,
				releaseSlotIds: ["s1"],
			}),
		});
		await act(() => result.current.confirmAbsent(p, false));
		const last = setAttendance.mock.calls.at(-1)?.[0] as {
			data: Record<string, unknown>;
		};
		expect(last.data.releaseHeldRoles).toBeUndefined();
		expect(result.current.absentBusy).toBe(false);
	});

	it("toasts what a release freed and welcomes a member back once", async () => {
		setAttendance.mockResolvedValue({
			released: [{ label: "Timer 1" }],
			welcomeBack: { lastPresentAt: "2026-09-01T00:00:00Z" },
		});
		const { result } = setup();
		await act(() => result.current.writeAttendance("a", "present"));
		await act(() => result.current.writeAttendance("a", "present"));
		const welcomes = toastSuccess.mock.calls.filter((c) =>
			String(c[0]).includes("Ann"),
		);
		expect(toastSuccess.mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(welcomes.length).toBe(1);
		setAttendance.mockResolvedValue({ released: [], welcomeBack: null });
	});

	it("adds, re-modes and removes a guest through the queue", async () => {
		const { result } = setup();
		await act(() => result.current.addRollGuest({ guestId: "g1" }));
		expect(addMinutesGuest).toHaveBeenLastCalledWith({
			data: { meetingId: "m1", guestId: "g1", mode: "in_person" },
		});
		expect((mutate.mock.calls[0]?.[1] as () => unknown)()).toMatchObject({
			type: "addGuest",
			guestId: "g1",
			name: "Gus",
		});
		await act(() => result.current.setRollGuestMode("g1", "online" as never));
		expect(addMinutesGuest).toHaveBeenLastCalledWith({
			data: {
				meetingId: "m1",
				guestId: "g1",
				mode: "online",
				replaceMode: true,
			},
		});
		await act(() => result.current.removeRollGuest("g1"));
		expect(removeMinutesGuest).toHaveBeenCalledWith({
			data: { meetingId: "m1", guestId: "g1" },
		});
		expect((mutate.mock.calls[2]?.[1] as () => unknown)()).toMatchObject({
			type: "removeGuest",
			guestId: "g1",
		});
	});

	it("an officer's effective plan is the loader's; a Toastmaster's is the verified fetch, and the panel waits for it", async () => {
		const officer = setup();
		expect(officer.result.current.effectivePlan).toEqual([{ memberId: "a" }]);
		expect(getTmodPanelData).not.toHaveBeenCalled();

		const tmod = setup({
			effectiveCanManage: false,
			needsTmodPlan: true,
			loaderRoster: [],
			plan: [],
		});
		expect(tmod.result.current.tmodPanelUnavailable).toBe(true);
		await vi.waitFor(() =>
			expect(tmod.result.current.tmodPanelUnavailable).toBe(false),
		);
		expect(getTmodPanelData).toHaveBeenCalledWith({
			data: { meetingId: "m1", memberId: "me" },
		});
		expect(tmod.result.current.effectivePlan).toEqual([{ memberId: "x" }]);
		expect(tmod.result.current.panelRosterForMode).toEqual([
			{ id: "x", name: "Xan" },
		]);
	});
});

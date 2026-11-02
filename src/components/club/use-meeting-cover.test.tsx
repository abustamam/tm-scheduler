// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingCover } from "./use-meeting-cover";

const invalidate = vi.fn(async () => {});
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
	toast: { success: (...a: unknown[]) => toastSuccess(...a) },
}));
const showWriteError = vi.fn();
vi.mock("#/components/write-error-toast", () => ({
	showWriteError: (...a: unknown[]) => showWriteError(...a),
}));
vi.mock("#/server/role-definitions", () => ({
	getPublicClubRoles: vi.fn(async () => []),
}));
vi.mock("#/server/meetings", () => ({}));
const s = {
	addSpeakerSlot: vi.fn(async (_a: unknown) => ({})),
	claimSlot: vi.fn(async (_a: unknown) => ({})),
	confirmSlot: vi.fn(async (_a: unknown) => ({})),
	moveEvaluatorSlot: vi.fn(async (_a: unknown) => ({})),
	moveSpeakerSlot: vi.fn(async (_a: unknown) => ({})),
	reassignSlot: vi.fn(async (_a: unknown) => ({})),
	releaseSlot: vi.fn(async (_a: unknown) => ({})),
	removeRoleSlot: vi.fn(async (_a: unknown) => ({})),
	removeSpeakerSlot: vi.fn(async (_a: unknown) => ({})),
	unconfirmSlot: vi.fn(async (_a: unknown) => ({})),
};
vi.mock("#/server/slots", () => ({
	addSpeakerSlot: (a: unknown) => s.addSpeakerSlot(a),
	claimSlot: (a: unknown) => s.claimSlot(a),
	confirmSlot: (a: unknown) => s.confirmSlot(a),
	moveEvaluatorSlot: (a: unknown) => s.moveEvaluatorSlot(a),
	moveSpeakerSlot: (a: unknown) => s.moveSpeakerSlot(a),
	reassignSlot: (a: unknown) => s.reassignSlot(a),
	releaseSlot: (a: unknown) => s.releaseSlot(a),
	removeRoleSlot: (a: unknown) => s.removeRoleSlot(a),
	removeSpeakerSlot: (a: unknown) => s.removeSpeakerSlot(a),
	unconfirmSlot: (a: unknown) => s.unconfirmSlot(a),
}));
const slotRef = { id: "slot1" };
vi.mock("./cover-landing-card", async (orig) => ({
	...(await orig<typeof import("./cover-landing-card")>()),
	coverLandingView: () => ({ slot: slotRef, roleLabel: "Timer" }),
}));
vi.mock("./cover-chip", () => ({
	coverMeetingOver: () => false,
	coverChipsFor: () => [{ request: { slotId: "slot1" } }],
}));

const requireIdentity = vi.fn(
	async (): Promise<{ id: string } | null> => ({
		id: "me",
	}),
);
const base = {
	clubUuid: "c1",
	clubSlug: "club",
	meeting: {
		id: "m1",
		status: "scheduled",
		scheduledAt: "2026-11-05T19:00:00Z",
	},
	slots: [],
	coverRequests: [],
	meetingNumber: 7,
	timezone: "UTC",
	urlKey: "uuid-1",
	search: {},
	now: new Date("2026-11-02T00:00:00Z"),
	over: false,
	roleCounts: {},
	canManage: false,
	effectiveCanManage: false,
	isSignedIn: true,
	myId: "me",
	managerActorId: "mgr" as string | null,
	requireIdentity,
};
function setup(over: Record<string, unknown> = {}) {
	const qc = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return renderHook(() => useMeetingCover({ ...base, ...over } as never), {
		wrapper,
	});
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("useMeetingCover", () => {
	it("hands a manager the manager actions: claim acts as the session member", async () => {
		const { result } = setup({ effectiveCanManage: true });
		await result.current.actions.claim(slotRef as never, undefined);
		expect(s.claimSlot).toHaveBeenCalledWith({
			data: {
				slotId: "slot1",
				memberId: "mgr",
				actorMemberId: "mgr",
				speakerDetails: undefined,
			},
		});
		expect(requireIdentity).not.toHaveBeenCalled();
	});

	it("refuses a manager claim with no linked member rather than writing", async () => {
		const { result } = setup({
			effectiveCanManage: true,
			managerActorId: null,
		});
		await expect(
			result.current.actions.claim(slotRef as never, undefined),
		).rejects.toThrow(/isn't linked/);
		expect(s.claimSlot).not.toHaveBeenCalled();
	});

	it("hands everyone else the self actions: claim resolves the identity first and stops when there is none", async () => {
		const { result } = setup();
		await result.current.actions.claim(slotRef as never, undefined);
		expect(s.claimSlot).toHaveBeenCalledWith({
			data: {
				slotId: "slot1",
				memberId: "me",
				actorMemberId: "me",
				speakerDetails: undefined,
			},
		});
		requireIdentity.mockResolvedValueOnce(null);
		await result.current.actions.claim(slotRef as never, undefined);
		expect(s.claimSlot).toHaveBeenCalledTimes(1);
	});

	it("self takeover and addSpeaker use the resolved identity", async () => {
		const { result } = setup();
		await result.current.actions.takeover?.(slotRef as never);
		expect(s.reassignSlot).toHaveBeenCalledWith({
			data: { slotId: "slot1", memberId: "me" },
		});
		await result.current.actions.addSpeaker?.();
		expect(s.addSpeakerSlot).toHaveBeenCalledWith({
			data: { meetingId: "m1", selfMemberId: "me" },
		});
		expect(toastSuccess).toHaveBeenCalledWith("Speaker added.");
	});

	it("refreshes the loader after a mutation", async () => {
		const { result } = setup();
		await result.current.actions.onMutated?.();
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("predicts a decline frees roles for an officer or for the viewer's own row only", () => {
		const officer = setup({ canManage: true }).result.current;
		expect(officer.declineFreesRoles("other")).toBe(true);
		const member = setup().result.current;
		expect(member.declineFreesRoles("me")).toBe(true);
		expect(member.declineFreesRoles("other")).toBe(false);
		const anon = setup({ isSignedIn: false }).result.current;
		expect(anon.declineFreesRoles("me")).toBe(false);
	});

	it("a late release opens the cover sheet for that slot, and closing clears it", () => {
		const { result } = setup();
		act(() =>
			result.current.onOwnLateRelease({ id: "slot1", role: "Timer" } as never),
		);
		expect(result.current.coverSlots).toHaveLength(1);
		expect(result.current.coverSlots[0]).toMatchObject({
			slotId: "slot1",
			meetingId: "m1",
			clubSlug: "club",
			urlKey: "uuid-1",
			timeZone: "UTC",
		});
		act(() => result.current.closeCoverSheet());
		expect(result.current.coverSlots).toEqual([]);
	});

	it("taking a covered role claims it as the resolved member, toasts the role and refreshes", async () => {
		const { result } = setup({ search: { cover: "slot1" } });
		await act(() => result.current.takeCoveredRole());
		expect(s.claimSlot).toHaveBeenCalledWith({
			data: {
				slotId: "slot1",
				memberId: "me",
				actorMemberId: "me",
				speakerDetails: undefined,
			},
		});
		expect(toastSuccess).toHaveBeenCalledWith("You're on as Timer.");
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(result.current.coverTakeBusy).toBe(false);
	});

	it("exposes the chip by slot id and dismisses the landing card", () => {
		const { result } = setup();
		expect(result.current.coverChipBySlotId.get("slot1")).toBeDefined();
		act(() => result.current.dismissCoverCard());
	});
});

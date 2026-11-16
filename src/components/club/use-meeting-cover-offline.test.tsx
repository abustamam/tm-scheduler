// @vitest-environment jsdom
/**
 * protects=the meeting page's claim, release and takeover go through
 *   `offlineMinutes.mutate` when the route hands one in (#1638), and are the
 *   bare server calls when it does not;
 * fails_when=an action calls the server directly despite `offlineMinutes`, the
 *   queued op loses its actor (a takeover carries none) or the viewer's name, or
 *   an action stops calling the server without it;
 * no_claim=what `mutate` does with the op (use-offline-minutes tests).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineMinutesHandle } from "./offline-role-writes";
import { useMeetingCover } from "./use-meeting-cover";

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: vi.fn(async () => {}) }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("#/components/write-error-toast", () => ({ showWriteError: vi.fn() }));
vi.mock("#/server/role-definitions", () => ({
	getPublicClubRoles: vi.fn(async () => []),
}));
vi.mock("#/server/meetings", () => ({}));
const s = vi.hoisted(() => ({
	claimSlot: vi.fn(async (_a: unknown) => ({})),
	reassignSlot: vi.fn(async (_a: unknown) => ({})),
	releaseSlot: vi.fn(async (_a: unknown) => ({})),
}));
vi.mock("#/server/slots", () => ({
	addSpeakerSlot: vi.fn(),
	claimSlot: (a: unknown) => s.claimSlot(a),
	confirmSlot: vi.fn(),
	moveEvaluatorSlot: vi.fn(),
	moveSpeakerSlot: vi.fn(),
	reassignSlot: (a: unknown) => s.reassignSlot(a),
	releaseSlot: (a: unknown) => s.releaseSlot(a),
	removeRoleSlot: vi.fn(),
	removeSpeakerSlot: vi.fn(),
	unconfirmSlot: vi.fn(),
}));

const slot = {
	id: "slot1",
	roleName: "Timer",
	assigneeName: "Zed Holder",
	assigneeId: "m-zed",
	assigneeGuestId: null,
};
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
	canManage: true,
	effectiveCanManage: true,
	isSignedIn: true,
	myId: "mgr",
	managerActorId: "mgr",
	requireIdentity: vi.fn(async () => ({ id: "mgr" })),
};

/** A handle whose `mutate` records the op and does NOT run the direct call, so
 *  a server call seen alongside it would be a bypass. */
function handle() {
	const queued: unknown[] = [];
	const mutate = vi.fn(
		async (_direct: () => Promise<unknown>, build: () => unknown) => {
			queued.push(build());
		},
	);
	const h = {
		busy: false,
		draining: false,
		pendingCount: 0,
		opMeta: () => ({ opId: "op1", queuedAt: 1, queuedBy: "mgr" }),
		mutate,
	} as unknown as OfflineMinutesHandle;
	return { h, queued, mutate };
}

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

describe("useMeetingCover with the offline queue (#1638)", () => {
	it("claim, release and takeover go through mutate with the right ops", async () => {
		const { h, queued, mutate } = handle();
		const { result } = setup({ offlineMinutes: h, myName: "Mia Manager" });
		const open = { ...slot, assigneeId: null, assigneeName: null };
		await result.current.actions.claim(open as never, undefined);
		await result.current.actions.release(slot as never);
		await result.current.actions.takeover(slot as never);
		expect(mutate).toHaveBeenCalledTimes(3);
		expect(s.claimSlot).not.toHaveBeenCalled();
		expect(s.releaseSlot).not.toHaveBeenCalled();
		expect(s.reassignSlot).not.toHaveBeenCalled();
		expect(queued[0]).toMatchObject({
			type: "assignSlot",
			memberId: "mgr",
			memberDisplayName: "Mia Manager",
			actorMemberId: "mgr",
			expectedHolder: null,
		});
		expect(queued[1]).toMatchObject({
			type: "releaseSlot",
			expectedHolder: "m:m-zed",
		});
		expect(queued[2]).toMatchObject({
			type: "assignSlot",
			memberId: "mgr",
			actorMemberId: null,
			expectedHolder: "m:m-zed",
		});
	});

	it("without offlineMinutes they are the bare server calls", async () => {
		const { result } = setup();
		await result.current.actions.claim(slot as never, undefined);
		await result.current.actions.release(slot as never);
		await result.current.actions.takeover(slot as never);
		expect(s.claimSlot).toHaveBeenCalledTimes(1);
		expect(s.releaseSlot).toHaveBeenCalledWith({ data: { slotId: "slot1" } });
		expect(s.reassignSlot).toHaveBeenCalledWith({
			data: { slotId: "slot1", memberId: "mgr" },
		});
	});
});

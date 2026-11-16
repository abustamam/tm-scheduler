// @vitest-environment jsdom
/**
 * The assign sheet with the offline queue (#1638).
 *
 * protects=guests are offered only online with nothing queued; a pick is made
 *   as today's call when the queue says so and is queued as an op (name, actor,
 *   expectedHolder, speaker TBA) otherwise; a reassign queues no actor; with no
 *   `offlineMinutes` the sheet is unchanged;
 * fails_when=guests show offline or with a queued op, the queued op loses its
 *   actor / holder / TBA, a reassign queues an actor, or `claimSlot` is no
 *   longer called online;
 * no_claim=the queue's own behavior (use-offline-minutes tests), real network.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { claimSlot, reassignSlot, online } = vi.hoisted(() => ({
	claimSlot: vi.fn(async () => ({ ok: true })),
	reassignSlot: vi.fn(async () => ({ ok: true })),
	online: { value: true },
}));
vi.mock("#/server/slots", () => ({ claimSlot, reassignSlot }));
vi.mock("#/server/guests", () => ({ assignGuestSlot: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("#/hooks/use-online-status", () => ({
	useOnlineStatus: () => online.value,
}));

import { AssignSlotSheet } from "#/components/club/assign-slot-sheet";
import type { OfflineMinutesHandle } from "#/components/club/offline-role-writes";

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver =
	ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	online.value = true;
});

/** A handle that behaves like the real one's two arms: direct when online with
 *  nothing queued, the built op otherwise. */
function handle(pendingCount: number) {
	const queued: unknown[] = [];
	const mutate = vi.fn(
		async (direct: () => Promise<unknown>, build: () => unknown) => {
			if (online.value && pendingCount === 0) await direct();
			else queued.push(build());
		},
	);
	const h = {
		busy: false,
		draining: false,
		pendingCount,
		opMeta: () => ({ opId: "op1", queuedAt: 1, queuedBy: "me" }),
		mutate,
	} as unknown as OfflineMinutesHandle;
	return { h, queued, mutate };
}

const openSlot = {
	id: "slot-open",
	roleDefinitionId: "timer",
	status: "open" as const,
	isSpeakerRole: false,
	label: "Timer",
	roleName: "Timer",
};
const heldSlot = {
	...openSlot,
	id: "slot-held",
	status: "claimed" as const,
	assigneeId: "m-zed",
	assigneeName: "Zed Holder",
};
const speakerSlot = { ...openSlot, id: "slot-sp", isSpeakerRole: true };

const baseProps = {
	roster: [{ id: "m-ann", name: "Ann Able" }],
	roleByMemberId: {},
	unavailableIds: [],
	roleRecency: {},
	actorMemberId: "me",
	allowGuests: true,
	clubGuests: [{ id: "g-1", name: "Gina Guest" }],
	onOpenChange: vi.fn(),
	onAssigned: vi.fn(),
};

describe("AssignSlotSheet with the offline queue (#1638)", () => {
	it("online with nothing queued: guests show and a pick calls claimSlot", async () => {
		const { h, queued } = handle(0);
		const user = userEvent.setup();
		render(
			<AssignSlotSheet {...baseProps} slot={openSlot} offlineMinutes={h} />,
		);
		expect(screen.getByText("Gina Guest")).toBeTruthy();
		expect(screen.getByText("Add a new guest")).toBeTruthy();
		expect(screen.getByPlaceholderText(/members and guests/)).toBeTruthy();
		await user.click(screen.getByText("Ann Able"));
		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(1));
		expect(queued).toEqual([]);
	});

	it("offline: no guest rows, no add-guest section, members-only placeholder; a pick queues", async () => {
		online.value = false;
		const { h, queued } = handle(0);
		const user = userEvent.setup();
		render(
			<AssignSlotSheet {...baseProps} slot={speakerSlot} offlineMinutes={h} />,
		);
		expect(screen.queryByText("Gina Guest")).toBeNull();
		expect(screen.queryByText("Add a new guest")).toBeNull();
		expect(screen.queryByPlaceholderText(/members and guests/)).toBeNull();
		expect(screen.getByPlaceholderText("Search members…")).toBeTruthy();
		await user.click(screen.getByText("Ann Able"));
		await waitFor(() => expect(queued).toHaveLength(1));
		expect(claimSlot).not.toHaveBeenCalled();
		expect(queued[0]).toMatchObject({
			type: "assignSlot",
			slotId: "slot-sp",
			memberId: "m-ann",
			memberDisplayName: "Ann Able",
			actorMemberId: "me",
			expectedHolder: null,
			speakerDetails: { speechTitle: "TBA" },
		});
	});

	it("online with one op queued: guests are hidden", () => {
		const { h } = handle(1);
		render(
			<AssignSlotSheet {...baseProps} slot={openSlot} offlineMinutes={h} />,
		);
		expect(screen.queryByText("Gina Guest")).toBeNull();
		expect(screen.queryByText("Add a new guest")).toBeNull();
	});

	it("a reassign queues no actor and the holder the officer saw", async () => {
		online.value = false;
		const { h, queued } = handle(0);
		const user = userEvent.setup();
		render(
			<AssignSlotSheet
				{...baseProps}
				canReassign
				slot={heldSlot}
				offlineMinutes={h}
			/>,
		);
		await user.click(screen.getByText("Ann Able"));
		await waitFor(() => expect(queued).toHaveLength(1));
		expect(queued[0]).toMatchObject({
			actorMemberId: null,
			expectedHolder: "m:m-zed",
			expectedHolderName: "Zed Holder",
		});
		expect(reassignSlot).not.toHaveBeenCalled();
	});

	it("without offlineMinutes: guests show and the call is made directly, as before", async () => {
		online.value = false;
		const user = userEvent.setup();
		render(<AssignSlotSheet {...baseProps} slot={openSlot} />);
		expect(screen.getByText("Gina Guest")).toBeTruthy();
		await user.click(screen.getByText("Ann Able"));
		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(1));
	});
});

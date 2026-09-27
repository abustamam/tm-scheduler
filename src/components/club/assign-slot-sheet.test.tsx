// @vitest-environment jsdom
/**
 * The assign sheet's session rule (#1003, ADR-0026).
 *
 * `reassignSlot` refuses a caller with no session since #763, while `claimSlot`
 * still takes the TMOD's asserted claim of an OPEN slot (#747). So the sheet
 * offers the picker on a HELD slot only where `canReassign` says the server
 * would accept it, and every refusal goes through `showWriteError` so a
 * sign-in refusal carries the one-tap "Sign in" action.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";

const { claimSlot, reassignSlot, toastError, toastSuccess } = vi.hoisted(
	() => ({
		claimSlot: vi.fn(async () => ({ ok: true })),
		reassignSlot: vi.fn(async () => ({ ok: true })),
		toastError: vi.fn(),
		toastSuccess: vi.fn(),
	}),
);
vi.mock("#/server/slots", () => ({ claimSlot, reassignSlot }));
vi.mock("#/server/guests", () => ({ assignGuestSlot: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

import { AssignSlotSheet } from "#/components/club/assign-slot-sheet";

// cmdk uses layout APIs that jsdom does not implement.
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
});

const openSlot = {
	id: "slot-open",
	roleDefinitionId: "timer",
	status: "open" as const,
	isSpeakerRole: false,
	label: "Timer",
};
const heldSlot = { ...openSlot, id: "slot-held", status: "claimed" as const };

const baseProps = {
	roster: [{ id: "m-ann", name: "Ann Able" }],
	roleByMemberId: {},
	unavailableIds: [],
	roleRecency: {},
	actorMemberId: "me",
	onOpenChange: vi.fn(),
	onAssigned: vi.fn(),
};

describe("AssignSlotSheet session rule (#1003)", () => {
	it("without canReassign, a HELD slot offers no picker and says why", () => {
		render(<AssignSlotSheet {...baseProps} slot={heldSlot} />);
		expect(screen.queryByText("Ann Able")).toBeNull();
		expect(screen.getByText(/Sign in to reassign it/)).toBeTruthy();
	});

	it("without canReassign, an OPEN slot still offers assign (the asserted claim)", async () => {
		const user = userEvent.setup();
		render(<AssignSlotSheet {...baseProps} slot={openSlot} />);
		await user.click(screen.getByText("Ann Able"));
		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(1));
		expect(claimSlot).toHaveBeenCalledWith({
			data: {
				slotId: "slot-open",
				memberId: "m-ann",
				actorMemberId: "me",
				speakerDetails: undefined,
			},
		});
		expect(reassignSlot).not.toHaveBeenCalled();
	});

	it("with canReassign, a HELD slot offers the picker and sends no actor", async () => {
		const user = userEvent.setup();
		render(<AssignSlotSheet {...baseProps} canReassign slot={heldSlot} />);
		await user.click(screen.getByText("Ann Able"));
		await waitFor(() => expect(reassignSlot).toHaveBeenCalledTimes(1));
		expect(reassignSlot).toHaveBeenCalledWith({
			data: { slotId: "slot-held", memberId: "m-ann" },
		});
	});

	it("a reassign with no member id (impersonating superadmin) is not stopped client-side", async () => {
		const user = userEvent.setup();
		render(
			<AssignSlotSheet
				{...baseProps}
				actorMemberId={null}
				canReassign
				slot={heldSlot}
			/>,
		);
		await user.click(screen.getByText("Ann Able"));
		await waitFor(() => expect(reassignSlot).toHaveBeenCalledTimes(1));
		expect(toastError).not.toHaveBeenCalled();
	});

	it("a sign-in refusal comes back with the one-tap Sign in action", async () => {
		reassignSlot.mockRejectedValueOnce(new Error(SIGN_IN_REQUIRED_MESSAGE));
		const user = userEvent.setup();
		render(<AssignSlotSheet {...baseProps} canReassign slot={heldSlot} />);
		await user.click(screen.getByText("Ann Able"));
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		const [message, options] = toastError.mock.calls[0] as unknown as [
			string,
			{ action?: { label: string } } | undefined,
		];
		expect(message).toBe(SIGN_IN_REQUIRED_MESSAGE);
		expect(options?.action?.label).toBe("Sign in");
	});
});

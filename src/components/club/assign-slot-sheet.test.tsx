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

describe("AssignSlotSheet one picker (#1332)", () => {
	const props = {
		...baseProps,
		roster: [
			{ id: "m-jose", name: "José Ruiz" },
			{ id: "m-rob", name: "Robert Smith", preferredName: "Bob" },
			{ id: "m-zed", name: "Zed Away" },
			{ id: "m-abe", name: "Abe Busy" },
			{ id: "m-cal", name: "Cal Free" },
		],
		roleByMemberId: { "m-abe": "Speaker" },
		unavailableIds: ["m-zed"],
	};
	const optionNames = () =>
		screen.getAllByRole("option").map((o) => o.textContent ?? "");

	it("finds a member by accent-free name and by preferred name", async () => {
		// protects: AC1, "jose" lists José Ruiz; "bob" lists Robert Smith with goes-by.
		// fails_when: the roster's preferredName is not passed to the picker.
		// no_claim: the server populating preferredName (integration tests).
		const user = userEvent.setup();
		render(<AssignSlotSheet {...props} slot={openSlot} />);
		await user.type(screen.getByPlaceholderText("Search members…"), "jose");
		expect(optionNames()).toHaveLength(1);
		expect(optionNames()[0]).toContain("José Ruiz");
		await user.clear(screen.getByPlaceholderText("Search members…"));
		await user.type(screen.getByPlaceholderText("Search members…"), "bob");
		expect(optionNames()[0]).toContain("Robert Smith · goes by Bob");
	});

	it("keeps today's empty-query order: available, then holding a role, then Not available", () => {
		// protects: AC3, tier order via rank equals buildPickerRows' order.
		// fails_when: rank is dropped (alphabetical only) or tiers are reordered.
		// no_claim: the sub-line and badge content.
		render(<AssignSlotSheet {...props} slot={openSlot} />);
		const names = optionNames().map((n) => n.split(/Never|Last/)[0]);
		const order = [
			"Cal Free",
			"José Ruiz",
			"Robert Smith",
			"Abe Busy",
			"Zed Away",
		];
		order.forEach((name, i) => {
			expect(names[i]).toContain(name);
		});
	});

	it("shows one input with Members and Guests groups, and a guest pick assigns that guest", async () => {
		// protects: AC2, no second search box; guest pick calls assignGuestSlot with guestId.
		// fails_when: the guest block keeps its own input, or a guest pick goes to claimSlot.
		// no_claim: the new-guest form (unchanged, not exercised here).
		const { assignGuestSlot } = await import("#/server/guests");
		vi.mocked(assignGuestSlot).mockResolvedValue({ ok: true } as never);
		const user = userEvent.setup();
		render(
			<AssignSlotSheet
				{...props}
				slot={openSlot}
				allowGuests
				clubGuests={[{ id: "g-1", name: "Gina Guest" }]}
			/>,
		);
		expect(screen.getByText("Members")).toBeTruthy();
		expect(screen.getByText("Guests")).toBeTruthy();
		expect(screen.queryByRole("textbox", { name: "Search guests" })).toBeNull();
		await user.click(screen.getByRole("option", { name: /Gina Guest/ }));
		await waitFor(() =>
			expect(assignGuestSlot).toHaveBeenCalledWith({
				data: { slotId: "slot-open", guestId: "g-1" },
			}),
		);
		expect(claimSlot).not.toHaveBeenCalled();
	});

	it("sorts a Not available exact match below an available substring match, still selectable", async () => {
		// protects: AC4, rank before tier, and unavailable stays pickable.
		// fails_when: tier ordering overrides the caller's rank, or unavailable rows are disabled.
		// no_claim: the dimmed name styling.
		const user = userEvent.setup();
		render(
			<AssignSlotSheet
				{...props}
				roster={[
					{ id: "m-ann", name: "Ann" },
					{ id: "m-joann", name: "Joanne" },
				]}
				unavailableIds={["m-ann"]}
				slot={openSlot}
			/>,
		);
		await user.type(screen.getByPlaceholderText("Search members…"), "ann");
		expect(optionNames()[0]).toContain("Joanne");
		expect(optionNames()[1]).toContain("Ann");
		await user.click(screen.getAllByRole("option")[1]!);
		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(1));
		expect(claimSlot).toHaveBeenCalledWith({
			data: expect.objectContaining({ memberId: "m-ann" }),
		});
	});
});

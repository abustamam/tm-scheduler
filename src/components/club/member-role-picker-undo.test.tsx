// @vitest-environment jsdom

// Undo on the role picker's release toast (#1427).

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { claimSlot, releaseSlot, toastSuccess } = vi.hoisted(() => ({
	claimSlot: vi.fn(async () => ({ ok: true })),
	releaseSlot: vi.fn(async () => ({ ok: true })),
	toastSuccess: vi.fn(),
}));
vi.mock("#/server/slots", () => ({
	claimSlot,
	releaseSlot,
	reassignSlot: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: vi.fn() },
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ navigate: vi.fn() }),
}));

import { MemberRolePicker } from "#/components/club/member-role-picker";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const data = {
	rows: [
		{
			roleDefinitionId: "rd1",
			slotIndex: 0,
			label: "Timer",
			shortCode: "TM",
			sortOrder: 1,
			isSpeakerRole: false,
		},
	],
	cells: [
		{
			meetingId: "mt1",
			roleDefinitionId: "rd1",
			slotIndex: 0,
			slotId: "slot-1",
			memberId: "m1",
			guestId: null,
		},
	],
	memberNames: [{ id: "m1", name: "Ann" }],
	guestNames: [],
} as never;

async function openAndRelease(isOwnRow: boolean) {
	render(
		<MemberRolePicker
			data={data}
			meetingId="mt1"
			meetingDate="Oct 6"
			targetMemberId="m1"
			targetName="Ann"
			isOwnRow={isOwnRow}
			canReassign={false}
			actorMemberId="m1"
			declined={false}
			onMarkUnavailable={() => {}}
			onMarkAvailable={() => {}}
			onChanged={async () => {}}
		>
			<button type="button">cell</button>
		</MemberRolePicker>,
	);
	await userEvent.click(screen.getByRole("button", { name: "cell" }));
	await userEvent.click(await screen.findByRole("button", { name: /Timer/ }));
	await waitFor(() => expect(releaseSlot).toHaveBeenCalledTimes(1));
	await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
	return toastSuccess.mock.calls[0][1] as
		| { action?: { label: string; onClick: () => void } }
		| undefined;
}

describe("MemberRolePicker: Undo on release (#1427)", () => {
	it("Undo on your own row re-claims the slot for the same member", async () => {
		// protects=own-row release toasts an Undo whose tap calls claimSlot with
		//   this slot, this member and this actor (asserted on the args)
		// fails_when=no action, or the claim names another slot/member
		// no_claim=server-side acceptance of the claim (stubbed)
		const opts = await openAndRelease(true);
		expect(opts?.action?.label).toBe("Undo");
		opts?.action?.onClick();
		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(1));
		expect(claimSlot).toHaveBeenCalledWith({
			data: { slotId: "slot-1", memberId: "m1", actorMemberId: "m1" },
		});
	});

	it("offers no Undo when releasing another member's row", async () => {
		// protects=an officer releasing someone else's role has no Undo
		// fails_when=the action is attached for every release
		// no_claim=toast wording
		const opts = await openAndRelease(false);
		expect(opts?.action).toBeUndefined();
	});
});

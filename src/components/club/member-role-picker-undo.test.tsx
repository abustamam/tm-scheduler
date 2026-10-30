// @vitest-environment jsdom

// Undo on the role picker's release toast (#1427).

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { claimSlot, releaseSlot, toastSuccess, toastError } = vi.hoisted(() => ({
	claimSlot: vi.fn(async () => ({ ok: true })),
	releaseSlot: vi.fn(async () => ({ ok: true })),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("#/server/slots", () => ({
	claimSlot,
	releaseSlot,
	reassignSlot: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ navigate: vi.fn() }),
}));

import { MemberRolePicker } from "#/components/club/member-role-picker";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const rowData = (isSpeakerRole: boolean) =>
	({
		rows: [
			{
				roleDefinitionId: "rd1",
				slotIndex: 0,
				label: "Timer",
				shortCode: "TM",
				sortOrder: 1,
				isSpeakerRole,
			},
		],
		cells: [
			{
				meetingId: "mt1",
				roleDefinitionId: "rd1",
				slotIndex: 0,
				slotId: "slot-1",
				memberId: "m-target",
				guestId: null,
			},
		],
		memberNames: [{ id: "m-target", name: "Ann" }],
		guestNames: [],
	}) as never;
const data = rowData(false);
const onChanged = vi.fn(async () => {});

async function openAndRelease(isOwnRow: boolean, d: never = data) {
	render(
		<MemberRolePicker
			data={d}
			meetingId="mt1"
			meetingDate="Oct 6"
			targetMemberId="m-target"
			targetName="Ann"
			isOwnRow={isOwnRow}
			canReassign={false}
			actorMemberId="m-actor"
			declined={false}
			onMarkUnavailable={() => {}}
			onMarkAvailable={() => {}}
			onChanged={onChanged}
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
			data: {
				slotId: "slot-1",
				memberId: "m-target",
				actorMemberId: "m-actor",
			},
		});
	});

	it("offers no Undo when releasing another member's row", async () => {
		// protects=an officer releasing someone else's role has no Undo
		// fails_when=the action is attached for every release
		// no_claim=toast wording
		const opts = await openAndRelease(false);
		expect(opts?.action).toBeUndefined();
	});

	it("a speaker role gets no Undo (release unlinks the speech)", async () => {
		// protects=a re-claim cannot restore a speech, so none is offered
		// fails_when=the isSpeakerRole gate is dropped
		// no_claim=whether a speech was actually attached (the picker cannot tell)
		const opts = await openAndRelease(true, rowData(true));
		expect(opts?.action).toBeUndefined();
	});

	it("a successful Undo toasts and refreshes the page", async () => {
		// protects=success path: "Assigned" toast and the onChanged refresh
		// fails_when=no refresh after the re-claim
		// no_claim=server acceptance (stubbed)
		const opts = await openAndRelease(true);
		onChanged.mockClear();
		toastSuccess.mockClear();
		opts?.action?.onClick();
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith("Assigned Timer.");
	});

	it("a refused re-claim shows the write-error toast and no success", async () => {
		// protects=undoRelease's catch routes through showWriteError
		// fails_when=the rejection is swallowed or toasts success
		// no_claim=error wording beyond the fallback
		const opts = await openAndRelease(true);
		toastSuccess.mockClear();
		onChanged.mockClear();
		claimSlot.mockRejectedValueOnce("taken" as never);
		opts?.action?.onClick();
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Couldn't undo."),
		);
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(onChanged).not.toHaveBeenCalled();
	});
});

describe("MemberRolePicker: the 48h cover gate (#1439)", () => {
	async function openAndPick(
		isOwnRow: boolean,
		hoursOut: number,
		onOwnLateRelease: (slotId: string) => void,
	) {
		render(
			<MemberRolePicker
				data={data}
				meetingId="mt1"
				meetingDate="Oct 6"
				targetMemberId="m-target"
				targetName="Ann"
				isOwnRow={isOwnRow}
				canReassign={false}
				actorMemberId="m-actor"
				declined={false}
				onMarkUnavailable={() => {}}
				onMarkAvailable={() => {}}
				onChanged={onChanged}
				scheduledAt={new Date(Date.now() + hoursOut * 3_600_000)}
				onOwnLateRelease={onOwnLateRelease}
			>
				<button type="button">cell</button>
			</MemberRolePicker>,
		);
		await userEvent.click(screen.getByRole("button", { name: "cell" }));
		await userEvent.click(await screen.findByRole("button", { name: /Timer/ }));
	}

	it("an own release more than 48h out still releases at once", async () => {
		// protects=AC2 for the picker
		// fails_when=the gate ignores the 48h window
		const late = vi.fn();
		await openAndPick(true, 100, late);
		await waitFor(() => expect(releaseSlot).toHaveBeenCalledTimes(1));
		expect(late).not.toHaveBeenCalled();
	});

	it("an officer releasing another member's row inside 48h still releases at once", async () => {
		// protects=AC2: the sheet is for your OWN drop only
		// fails_when=isOwnRow stops being part of the gate
		const late = vi.fn();
		await openAndPick(false, 20, late);
		await waitFor(() => expect(releaseSlot).toHaveBeenCalledTimes(1));
		expect(late).not.toHaveBeenCalled();
	});

	it("an own release inside 48h goes to the sheet and releases nothing", async () => {
		// protects=AC1 for the picker (the other side of the two cases above)
		// fails_when=a late own release is written
		const late = vi.fn();
		await openAndPick(true, 20, late);
		await waitFor(() => expect(late).toHaveBeenCalledWith("slot-1"));
		expect(releaseSlot).not.toHaveBeenCalled();
	});
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SyncStatus,
	type SyncStatusProps,
} from "#/components/club/sync-status";

const idle: SyncStatusProps = {
	online: true,
	queueCount: 0,
	draining: false,
	syncError: null,
	justSynced: false,
	onRetry: () => {},
};

describe("SyncStatus held role changes (#1638)", () => {
	afterEach(() => cleanup());

	// protects=the held line names what is waiting and for whom, and offers
	//   Discard; nothing shows when no op is held;
	// fails_when=the line is missing, shows at a count of 0, or is hidden by the
	//   idle steady state;
	// no_claim=the hook's count (a prop here).
	it("shows the held line with a count, and nothing at zero", () => {
		const { container, rerender } = render(
			<SyncStatus {...idle} heldCount={2} onDiscardHeld={() => {}} />,
		);
		expect(container.textContent).toContain(
			"2 role changes on this device are waiting for the member who made them.",
		);
		expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
		rerender(<SyncStatus {...idle} heldCount={0} onDiscardHeld={() => {}} />);
		expect(container.textContent).toBe("");
	});

	// protects=Discard is a two-step inline confirm: the first click only asks,
	//   the second ("Discard N changes?") discards; Keep backs out;
	// fails_when=the first click discards, or the confirm never reaches the
	//   callback;
	// no_claim=what the callback does (hook test).
	it("Discard asks first, then discards; Keep backs out", async () => {
		const user = userEvent.setup();
		const onDiscardHeld = vi.fn();
		render(
			<SyncStatus {...idle} heldCount={2} onDiscardHeld={onDiscardHeld} />,
		);
		await user.click(screen.getByRole("button", { name: "Discard" }));
		expect(onDiscardHeld).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Keep" }));
		expect(onDiscardHeld).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Discard" }));
		await user.click(
			screen.getByRole("button", { name: "Discard 2 changes?" }),
		);
		expect(onDiscardHeld).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
	});

	// protects=the held line sits beside the normal status instead of replacing
	//   it: a real sync error keeps its Retry;
	// fails_when=the held line suppresses the error banner;
	// no_claim=layout.
	it("keeps a real sync error and its Retry beside the held line", () => {
		render(
			<SyncStatus
				{...idle}
				syncError="boom"
				heldCount={1}
				onDiscardHeld={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
	});
});

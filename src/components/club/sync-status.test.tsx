// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SyncStatus,
	type SyncStatusProps,
} from "#/components/club/sync-status";

// This component had no test file of its own — it was exercised only through the
// two surfaces that render it, which is why the state below could not be reached
// by any assertion. The prop pair the panel's own suite varies is
// `{online:false, queueCount:n}`; nothing ever asked what an ONLINE queue looks
// like, and `pendingCount = online ? 0 : queueCount` made the answer "nothing".

const idle: SyncStatusProps = {
	online: true,
	queueCount: 0,
	draining: false,
	syncError: null,
	justSynced: false,
	onRetry: () => {},
};

describe("SyncStatus", () => {
	// vitest runs without `globals` here, so testing-library's auto-cleanup never
	// registers and renders leak between tests (every component suite in this repo
	// carries this line — see meeting-attendance-panel.test.tsx).
	afterEach(() => cleanup());

	it("says an ONLINE queue is not yet synced (F3)", () => {
		// THE state the write deadline created and this indicator was blind to: a
		// write abandoned at its deadline is queued while `navigator.onLine` is
		// still true, so `online && queueCount > 0 && !draining && !syncError` is
		// normal now rather than near-unreachable. It rendered `null` — an officer
		// mid-roll-call had nothing at all telling them the tap had not reached the
		// server, on the one surface where that matters.
		const { getByText } = render(<SyncStatus {...idle} queueCount={2} />);
		getByText(/2 changes not yet synced/);
	});

	it("words the online and offline pending states DIFFERENTLY", () => {
		// Not one string with a number in it. "Saved on this device — will sync when
		// you're back online" is a promise about a future reconnection, and it is
		// the wrong thing to say to someone whose phone believes it IS online: the
		// reconnection they are waiting for has, as far as the device is concerned,
		// already happened. Distinct copy is what makes the two situations
		// distinguishable to the officer, and to a test.
		const on = render(<SyncStatus {...idle} queueCount={1} />);
		on.getByText(/1 change not yet synced/);
		expect(on.queryByText(/saved on this device/)).toBeNull();
		on.unmount();

		const off = render(<SyncStatus {...idle} online={false} queueCount={1} />);
		off.getByText(/1 change saved on this device/);
		expect(off.queryByText(/not yet synced/)).toBeNull();
	});

	it("pluralises both pending copies on the count", () => {
		const one = render(<SyncStatus {...idle} queueCount={1} />);
		one.getByText(/1 change not yet/);
		expect(one.queryByText(/1 changes/)).toBeNull();
		one.unmount();

		const many = render(<SyncStatus {...idle} online={false} queueCount={3} />);
		many.getByText(/3 changes saved/);
	});

	it("prefers the in-flight drain over the pending count", () => {
		// Priority order is load-bearing now that the pending state is reachable
		// while online: a drain in flight has a non-empty queue BY DEFINITION, so
		// without the ordering the officer would be told changes are "not yet
		// synced" during the very second they are being synced.
		const { getByText, queryByText } = render(
			<SyncStatus {...idle} draining={true} queueCount={3} />,
		);
		getByText(/Syncing 3 changes/);
		expect(queryByText(/not yet synced/)).toBeNull();
	});

	it("prefers the error banner over the pending count, and Retry is wired", async () => {
		// Same reason: a stopped drain leaves the ops queued, so both states hold at
		// once and only one of them offers a way out.
		const onRetry = vi.fn();
		const { getByText, getByRole, queryByText } = render(
			<SyncStatus
				{...idle}
				syncError="No response from the network."
				queueCount={2}
				onRetry={onRetry}
			/>,
		);
		getByText(/Couldn't sync changes/);
		expect(queryByText(/not yet synced/)).toBeNull();
		await userEvent.click(getByRole("button", { name: "Retry" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("shows the transient confirmation only once the queue is EMPTY", () => {
		// "All changes synced" over a non-empty queue is the false reassurance the
		// stranded-drain bug produced. The ordering is what prevents it, so it is
		// asserted rather than assumed.
		const empty = render(<SyncStatus {...idle} justSynced={true} />);
		empty.getByText(/All changes synced/);
		empty.unmount();

		const stillQueued = render(
			<SyncStatus {...idle} justSynced={true} queueCount={1} />,
		);
		expect(stillQueued.queryByText(/All changes synced/)).toBeNull();
		stillQueued.getByText(/1 change not yet synced/);
	});

	it("F7: announces every state, and the ERROR assertively", () => {
		// There was no `aria-live`, `role="status"` or `role="alert"` anywhere in this
		// component — on the surface whose whole job is "did this reach the server".
		// Since roll mode this is the primary attendance-write indicator, so the
		// transition into "Couldn't sync changes — Retry" reaching nobody is the worst
		// of the four.
		//
		// Queried by ROLE, which is the observable: `<output>` carries the implicit
		// `status` role, so this fails for a plain `<p>` and passes without any
		// attribute being spelled out.
		const drain = render(
			<SyncStatus {...idle} draining={true} queueCount={2} />,
		);
		expect(drain.getByRole("status").textContent).toContain("Syncing 2");
		drain.unmount();

		const pending = render(<SyncStatus {...idle} queueCount={1} />);
		expect(pending.getByRole("status").textContent).toContain("not yet synced");
		pending.unmount();

		const done = render(<SyncStatus {...idle} justSynced={true} />);
		expect(done.getByRole("status").textContent).toContain(
			"All changes synced",
		);
		done.unmount();

		// The error is ASSERTIVE and must not be a `status`: it is the one state that
		// asks the officer to act, and asserting `role="alert"` specifically is what
		// stops "make them all `status`" from passing.
		const failed = render(<SyncStatus {...idle} syncError="nope" />);
		expect(failed.getByRole("alert").textContent).toContain(
			"Couldn't sync changes",
		);
		expect(failed.queryByRole("status")).toBeNull();
	});

	it("renders nothing in the steady state", () => {
		// The empty-document control. Every assertion above is a `getByText`, so a
		// component that rendered its copy unconditionally would satisfy them all.
		const { container } = render(<SyncStatus {...idle} />);
		expect(container.textContent).toBe("");
	});
});

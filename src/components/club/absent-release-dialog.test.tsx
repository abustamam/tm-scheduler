// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AbsentReleaseDialog,
	type PendingAbsent,
} from "#/components/club/absent-release-dialog";

/**
 * The confirm step between roll mode's "Absent" chip and a member's roles going
 * back to the open pool (#1256). Presentational, so the answer each button gives
 * is asserted here and what the route does with it is the route guard's job.
 */
function pending(over: Partial<PendingAbsent> = {}): PendingAbsent {
	return {
		memberId: "m1",
		name: "Ana Ruiz",
		roles: [
			{ slotId: "s2", label: "Speaker 2", speechTitle: "Ice Breaker" },
			{ slotId: "t1", label: "Timer", speechTitle: null },
		],
		...over,
	};
}

function mount(
	over: Partial<React.ComponentProps<typeof AbsentReleaseDialog>>,
) {
	const handlers = {
		onRelease: vi.fn(),
		onKeep: vi.fn(),
		onCancel: vi.fn(),
	};
	const utils = render(
		<AbsentReleaseDialog pending={pending()} {...handlers} {...over} />,
	);
	return { ...utils, ...handlers };
}

describe("AbsentReleaseDialog (#1256)", () => {
	// No `globals`, so testing-library's auto-cleanup never registers.
	afterEach(() => cleanup());

	it("offers Release roles (focused), Keep roles and Cancel, each giving its own answer", async () => {
		// protects=three buttons, Release focused by default, and each calls exactly
		//   its own handler with the pending member (Keep and Release are different
		//   writes: false vs true)
		// fails_when=Keep and Release are wired to the same handler, Release loses
		//   autofocus, or Cancel calls a write handler
		// no_claim=what the route writes for each answer (route guard); Radix's
		//   Escape/overlay close path is not exercised
		const user = userEvent.setup();
		const { getByRole, onRelease, onKeep, onCancel } = mount({});

		expect(getByRole("dialog").textContent).toContain("Mark Ana Ruiz absent?");
		expect(document.activeElement).toBe(
			getByRole("button", { name: "Release roles" }),
		);

		await user.click(getByRole("button", { name: "Keep roles" }));
		expect(onKeep).toHaveBeenCalledWith(pending());
		expect(onRelease).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		await user.click(getByRole("button", { name: "Release roles" }));
		expect(onRelease).toHaveBeenCalledWith(pending());
		expect(onKeep).toHaveBeenCalledTimes(1);

		await user.click(getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onRelease).toHaveBeenCalledTimes(1);
	});

	it("names every role, and a speech's title goes back to the member's queue", () => {
		// protects=one line per role with the numbered label, and the speech line for
		//   a slot that has a speech attached; none for a slot without
		// fails_when=a count replaces the names, the title is dropped, or a role
		//   with no speech gets the queue sentence
		// no_claim=that the speech really survives unscheduled (integration suite)
		const { getAllByRole } = mount({});
		const lines = getAllByRole("listitem").map((li) => li.textContent);
		expect(lines).toEqual([
			"Speaker 2 — 'Ice Breaker' goes back to their queue",
			"Timer",
		]);
	});

	it("says the release waits for reconnection only when offline", () => {
		// protects=the offline line "Roles will be released when you're back online."
		//   shows offline and is absent online
		// fails_when=the line is always on (a lie online), never on, or not tied to
		//   the `offline` prop
		// no_claim=that the route passes the real connectivity (route guard)
		const online = mount({ offline: false });
		expect(online.getByRole("dialog").textContent).not.toContain("back online");
		cleanup();
		const offline = mount({ offline: true });
		expect(offline.getByRole("dialog").textContent).toContain(
			"Roles will be released when you're back online.",
		);
	});
});

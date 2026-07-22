// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredMember } from "#/lib/member-identity";
import type { SeasonGridData } from "#/server/season-grid";

// season-grid.tsx pulls in the availability + slots server-fn modules at
// import time (they define createServerFns), which reach for #/db →
// DATABASE_URL outside a real server context. Stub them so the component can
// mount in jsdom; claimSlot/releaseSlot are the ones this test exercises.
// `vi.mock` factories are hoisted above imports, so the mock fns must be
// created via `vi.hoisted` rather than plain top-level `const`s.
const { claimSlot, releaseSlot, toastSuccess, toastError } = vi.hoisted(() => ({
	claimSlot: vi.fn(async () => ({ ok: true })),
	releaseSlot: vi.fn(async () => ({ ok: true })),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("#/server/slots", () => ({ claimSlot, releaseSlot }));
vi.mock("#/server/availability", () => ({
	clearAvailability: vi.fn(),
	markUnavailableReleasing: vi.fn(),
	setAvailability: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

import { SeasonGrid } from "./season-grid";

// jsdom doesn't implement scrollIntoView; SeasonGrid calls it on mount to
// bring the anchor meeting column into view.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

const data: SeasonGridData = {
	meetings: [
		{
			id: "m1",
			scheduledAt: "2026-07-01T19:00:00Z",
			timezone: "UTC",
			urlKey: "2026-07-01",
			openCount: 1,
			totalSlots: 1,
			isPast: false,
			isAnchor: true,
			isCompleted: false,
		},
	],
	rows: [
		{
			roleDefinitionId: "ti",
			slotIndex: 0,
			label: "Timer",
			shortCode: "Time",
			sortOrder: 0,
			isSpeakerRole: false,
		},
	],
	members: [],
	memberNames: [],
	guestNames: [],
	cells: [
		{
			slotId: "slot-1",
			meetingId: "m1",
			roleDefinitionId: "ti",
			slotIndex: 0,
			memberId: null,
			guestId: null,
			status: "open",
		},
	],
	unavailable: [],
	contacted: [],
};

const PICKED: StoredMember = { id: "m-picked", name: "Picked Member" };

// SeasonGrid renders <Link>s (meeting header, member row), so mount it under
// a minimal router — mirrors the pattern in guest-resources.test.tsx.
async function renderGrid(requireIdentity: () => Promise<StoredMember | null>) {
	const rootRoute = createRootRoute({
		component: () => (
			<SeasonGrid
				data={data}
				orientation="roles"
				count="all"
				currentMemberId={null}
				requireIdentity={requireIdentity}
			/>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("SeasonGrid prospective claim + undo", () => {
	afterEach(() => {
		claimSlot.mockClear();
		releaseSlot.mockClear();
		toastSuccess.mockClear();
		toastError.mockClear();
	});

	it("claims with the freshly-resolved identity, and Undo releases with that SAME id (not the stale null prop)", async () => {
		const requireIdentity = vi.fn(async () => PICKED);
		await renderGrid(requireIdentity);

		const claimBtn = await screen.findByRole("button", { name: /claim/i });
		await userEvent.click(claimBtn);

		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(1));
		expect(claimSlot).toHaveBeenCalledWith({
			data: {
				slotId: "slot-1",
				memberId: PICKED.id,
				actorMemberId: PICKED.id,
			},
		});

		// Grab the "Undo" action off the success toast and invoke it directly —
		// sonner's <Toaster/> isn't mounted, so this is the wiring's contract,
		// not the visual toast.
		expect(toastSuccess).toHaveBeenCalledTimes(1);
		const [, options] = toastSuccess.mock.calls[0];
		expect(options.action.label).toBe("Undo");
		options.action.onClick();

		await waitFor(() => expect(releaseSlot).toHaveBeenCalledTimes(1));
		// The Critical bug: release() closed over the render's (null)
		// currentMemberId instead of the resolved memberId, so Undo no-op'd.
		expect(releaseSlot).toHaveBeenCalledWith({
			data: { slotId: "slot-1", actorMemberId: PICKED.id },
		});
	});

	it("aborts cleanly (no claim call) when the identity picker is dismissed", async () => {
		const requireIdentity = vi.fn(async () => null);
		await renderGrid(requireIdentity);

		const claimBtn = await screen.findByRole("button", { name: /claim/i });
		await userEvent.click(claimBtn);

		await waitFor(() => expect(requireIdentity).toHaveBeenCalledTimes(1));
		expect(claimSlot).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});
});

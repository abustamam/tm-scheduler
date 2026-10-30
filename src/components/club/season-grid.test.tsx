// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	act,
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredMember } from "#/lib/member-identity";
import type { SeasonGridData } from "#/server/season-grid";
import { renderUnderMemoryRouter } from "#/test/router-harness";

// season-grid.tsx pulls in the availability + slots server-fn modules at
// import time (they define createServerFns), which reach for #/db →
// DATABASE_URL outside a real server context. Stub them so the component can
// mount in jsdom; claimSlot/releaseSlot are the ones this test exercises.
// `vi.mock` factories are hoisted above imports, so the mock fns must be
// created via `vi.hoisted` rather than plain top-level `const`s.
const {
	claimSlot,
	clearAvailability,
	markUnavailableReleasing,
	releaseSlot,
	setAvailability,
	toastSuccess,
	toastMessage,
	toastError,
	anchorScroll,
} = vi.hoisted(() => ({
	anchorScroll: vi.fn(),
	// #763: like `setAvailability`, the claim REPORTS its proof and the grid
	// offers Undo (a session-gated release) only on `"session"`.
	claimSlot: vi.fn(
		async (): Promise<{ ok: true; proof: "session" | "asserted" | null }> => ({
			ok: true,
			proof: "session",
		}),
	),
	// The clear REPORTS whether it removed anything, and the grid offers Undo
	// (a re-decline) only when it did; a mock returning a bare `{ ok: true }`
	// models a server that never shipped, so the default is the clear that landed.
	clearAvailability: vi.fn(
		async (): Promise<{ ok: true; cleared: boolean }> => ({
			ok: true,
			cleared: true,
		}),
	),
	markUnavailableReleasing: vi.fn(async () => ({ ok: true, released: 1 })),
	releaseSlot: vi.fn(async () => ({ ok: true })),
	// #762: the handler REPORTS how the caller's identity was established, and
	// the grid reads it to decide whether to offer Undo. A mock returning a bare
	// `{ ok: true }` models a server that never shipped, so the default here is
	// the session case and the anon case sets its own.
	setAvailability: vi.fn(async () => ({ ok: true, proof: "session" })),
	toastSuccess: vi.fn(),
	toastMessage: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("#/server/slots", () => ({ claimSlot, releaseSlot }));
vi.mock("#/server/availability", () => ({
	clearAvailability,
	markUnavailableReleasing,
	setAvailability,
}));
// Spy-through: the real helper still runs; the spy counts its calls (#1316).
vi.mock("#/lib/season-grid-anchor-scroll", async (orig) => {
	const actual = await orig<typeof import("#/lib/season-grid-anchor-scroll")>();
	return {
		...actual,
		scrollAnchorClearOfPinnedColumn: (
			...a: Parameters<typeof actual.scrollAnchorClearOfPinnedColumn>
		) => {
			anchorScroll(...a);
			return actual.scrollAnchorClearOfPinnedColumn(...a);
		},
	};
});
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, message: toastMessage, error: toastError },
}));

import {
	NOT_COMING_NO_ROLE_TEXT,
	ROLE_FREED_DUTY_TEXT,
} from "#/lib/role-duty-copy";
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

// Members orientation, admin viewer: a free member cell that's in the
// contacted set (#340). Reuses `data`'s single upcoming, non-past,
// non-completed meeting — that's what makes the editable-button branch active.
const membersData: SeasonGridData = {
	...data,
	members: [{ id: "c1", name: "Carla Nguyen" }],
	memberNames: [{ id: "c1", name: "Carla Nguyen" }],
	contacted: [{ memberId: "c1", meetingId: "m1" }],
};

// Members × Meetings as an admin (canManageOthers): every row's cell renders
// through the editable `<MemberRolePicker>`-wrapped button, not `<GridCell>`.
async function renderMembersGrid(
	over: {
		currentMemberSource?: "anon" | "session";
		currentMemberId?: string;
		canManageOthers?: boolean;
		data?: SeasonGridData;
		onChanged?: () => void | Promise<void>;
	} = {},
) {
	const rootRoute = createRootRoute({
		component: () => (
			<SeasonGrid
				data={over.data ?? membersData}
				orientation="members"
				count="all"
				currentMemberId={over.currentMemberId ?? "admin-1"}
				// #762: WHERE that id came from. The grid defaults to `"anon"` (the
				// narrow side), so every case that wants the officer behaviour has to
				// say so — which is the point.
				currentMemberSource={over.currentMemberSource ?? "session"}
				canManageOthers={over.canManageOthers ?? true}
				clubId="club-1"
				onChanged={over.onChanged}
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

// Members × Meetings with the signed-in Contact columns on (#198). `members`
// carries the contact payload and also drives the member axis, so its `name` is
// what `row.label` resolves to. Carla has a number and Dev has none — the two
// states the phone cell renders. Both carry an email so the only em dash in the
// grid is Dev's empty phone cell.
const contactData: SeasonGridData = {
	...data,
	members: [
		{
			id: "c1",
			name: "Carla Nguyen",
			email: "carla@example.com",
			phone: "+14155552671",
		},
		{ id: "c2", name: "Dev Patel", email: "dev@example.com", phone: null },
	],
	memberNames: [
		{ id: "c1", name: "Carla Nguyen" },
		{ id: "c2", name: "Dev Patel" },
	],
};

// Same admin mount as `renderMembersGrid`, plus `showContact` — the Email and
// Phone columns only render on the members axis for a signed-in viewer.
async function renderContactGrid() {
	await renderUnderMemoryRouter(
		<SeasonGrid
			data={contactData}
			orientation="members"
			count="all"
			currentMemberId="admin-1"
			canManageOthers
			showContact
			clubId="club-1"
		/>,
	);
}

// SeasonGrid renders <Link>s (meeting header, member row), so mount it under
// a minimal router — mirrors the pattern in guest-resources.test.tsx.
async function renderGrid(
	requireIdentity?: () => Promise<StoredMember | null>,
	over: {
		data?: SeasonGridData;
		currentMemberId?: string | null;
		currentMemberSource?: "anon" | "session";
	} = {},
) {
	const rootRoute = createRootRoute({
		component: () => (
			<SeasonGrid
				data={over.data ?? data}
				orientation="roles"
				count="all"
				currentMemberId={over.currentMemberId ?? null}
				currentMemberSource={over.currentMemberSource}
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

	it("claims with the freshly-resolved identity, and a SESSION claim's Undo releases that slot", async () => {
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
		// The Critical bug this once caught — release() closing over the render's
		// null identity and no-op'ing — cannot recur: since #763 the release
		// carries no actor at all, the server credits the session.
		expect(releaseSlot).toHaveBeenCalledWith({ data: { slotId: "slot-1" } });
	});

	it("withholds Undo from an ASSERTED claim (#763)", async () => {
		// Undo is `releaseSlot`, session-gated since #763. Offered to a name-pick
		// its every tap would come back "you need to be signed in" on the toast
		// that just said the claim worked.
		claimSlot.mockResolvedValueOnce({ ok: true, proof: "asserted" });
		await renderGrid(vi.fn(async () => PICKED));
		await userEvent.click(
			await screen.findByRole("button", { name: /claim/i }),
		);

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess.mock.calls[0]?.[0]).toBe("Role claimed.");
		expect(toastSuccess.mock.calls[0]?.[1]?.action).toBeUndefined();
		expect(releaseSlot).not.toHaveBeenCalled();
	});

	it("withholds Undo when the claim reports no proof (impersonated or stale)", async () => {
		claimSlot.mockResolvedValueOnce({ ok: true, proof: null });
		await renderGrid(vi.fn(async () => PICKED));
		await userEvent.click(
			await screen.findByRole("button", { name: /claim/i }),
		);

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess.mock.calls[0]?.[1]?.action).toBeUndefined();
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

describe("SeasonGrid: no Claim on a completed or past meeting (#1107)", () => {
	afterEach(() => claimSlot.mockClear());
	const liveMeeting = data.meetings[0]!;
	const liveCell = data.cells[0]!;
	// A locked column beside the live one, so the lock must land on the RIGHT
	// column: Claim has to survive on m1 and be absent on m2.
	function mixed(locked: { isCompleted: boolean; isPast: boolean }) {
		return {
			...data,
			meetings: [
				liveMeeting,
				{
					...liveMeeting,
					id: "m2",
					urlKey: "2026-06-24",
					scheduledAt: "2026-06-24T19:00:00Z",
					isAnchor: false,
					...locked,
				},
			],
			cells: [liveCell, { ...liveCell, slotId: "slot-2", meetingId: "m2" }],
		} satisfies SeasonGridData;
	}
	const claimButtons = () =>
		screen.queryAllByRole("button", { name: /claim/i });

	it("a signed-in member gets Claim on the live column only, beside a completed one", async () => {
		await renderGrid(undefined, {
			data: mixed({ isCompleted: true, isPast: false }),
			currentMemberId: "m-me",
			currentMemberSource: "session",
		});
		expect(claimButtons()).toHaveLength(1);
		await userEvent.click(claimButtons()[0]!);
		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(1));
		expect(claimSlot).toHaveBeenCalledWith({
			data: expect.objectContaining({ slotId: "slot-1" }),
		});
	});

	it("a past meeting that is still scheduled offers no Claim either", async () => {
		await renderGrid(undefined, {
			data: mixed({ isCompleted: false, isPast: true }),
			currentMemberId: "m-me",
			currentMemberSource: "session",
		});
		expect(claimButtons()).toHaveLength(1);
		await userEvent.click(claimButtons()[0]!);
		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(1));
		expect(claimSlot).toHaveBeenCalledWith({
			data: expect.objectContaining({ slotId: "slot-1" }),
		});
	});

	it("an anonymous visitor gets Claim on live data — the control", async () => {
		await renderGrid(vi.fn(async () => PICKED));
		expect(claimButtons()).toHaveLength(1);
	});

	it("an anonymous visitor gets Claim on the live column only, beside a completed one", async () => {
		await renderGrid(
			vi.fn(async () => PICKED),
			{
				data: mixed({ isCompleted: true, isPast: false }),
			},
		);
		expect(claimButtons()).toHaveLength(1);
	});

	it("an anonymous visitor gets Claim on the live column only, beside a past one", async () => {
		await renderGrid(
			vi.fn(async () => PICKED),
			{
				data: mixed({ isCompleted: false, isPast: true }),
			},
		);
		expect(claimButtons()).toHaveLength(1);
	});
});

describe("SeasonGrid: your own role is a release control only with a session (#763)", () => {
	const mine: SeasonGridData = {
		...data,
		memberNames: [{ id: PICKED.id, name: PICKED.name }],
		cells: [
			{
				slotId: "slot-1",
				meetingId: "m1",
				roleDefinitionId: "ti",
				slotIndex: 0,
				memberId: PICKED.id,
				guestId: null,
				status: "claimed",
			},
		],
	};

	afterEach(() => {
		releaseSlot.mockClear();
		toastSuccess.mockClear();
		toastError.mockClear();
	});

	it("an anon name-pick sees their role but cannot tap it into a refusal", async () => {
		await renderGrid(undefined, {
			data: mine,
			currentMemberId: PICKED.id,
			currentMemberSource: "anon",
		});
		// The state stays: the cell still names the holder.
		expect(await screen.findByText(/Picked/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Release / })).toBeNull();
	});

	it("a signed-in member can release it — the control", async () => {
		await renderGrid(undefined, {
			data: mine,
			currentMemberId: PICKED.id,
			currentMemberSource: "session",
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Release / }),
		);
		await waitFor(() =>
			expect(releaseSlot).toHaveBeenCalledWith({ data: { slotId: "slot-1" } }),
		);
	});
});

describe("SeasonGrid availability Undo is gated on the write's proof (#762)", () => {
	afterEach(() => {
		setAvailability.mockClear();
		clearAvailability.mockClear();
		toastSuccess.mockClear();
		toastError.mockClear();
	});

	/** The header chip marks the VIEWER unavailable for that meeting — the one
	 *  availability write reachable in one click from this fixture. */
	async function markSelfUnavailable() {
		await renderMembersGrid({ currentMemberId: "c1" });
		const chip = await screen.findByRole("button", { name: /^Can't go —/ });
		await userEvent.click(chip);
		await waitFor(() => expect(setAvailability).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledTimes(1);
		return toastSuccess.mock.calls[0]?.[1] as
			| { action?: { label: string; onClick: () => void } }
			| undefined;
	}

	it("offers Undo when the write was SESSION-proven", async () => {
		// The control, and it is the half that matters most: the undo is the
		// product, and a gate that removed it for everyone would satisfy the
		// negative below.
		const options = await markSelfUnavailable();
		expect(options?.action?.label).toBe("Undo");
		options?.action?.onClick();
		await waitFor(() => expect(clearAvailability).toHaveBeenCalledTimes(1));
	});

	it("withholds Undo when the write was only ASSERTED", async () => {
		// Undo is `clearAvailability`, which destroys an answer and so needs a
		// session (ADR-0026). Offered to an anonymous roster pick it is a control
		// whose every tap comes back "you need to be signed in" — on the one toast
		// that just said the write worked.
		setAvailability.mockResolvedValueOnce({ ok: true, proof: "asserted" });
		const options = await markSelfUnavailable();
		expect(options?.action).toBeUndefined();
		// The toast itself still fires: the write DID land, and saying nothing
		// would be worse than saying it without an undo.
		expect(toastSuccess.mock.calls[0]?.[0]).toMatch(/marked unavailable/i);
		expect(clearAvailability).not.toHaveBeenCalled();
	});

	it("withholds Undo when the server reports no proof at all", async () => {
		// Fails CLOSED on a shape it does not recognise — a tab that outlived a
		// deploy, or a field renamed. The alternative default is a control that
		// refuses, which is the thing being removed.
		setAvailability.mockResolvedValueOnce({ ok: true } as never);
		const options = await markSelfUnavailable();
		expect(options?.action).toBeUndefined();
	});
});

describe("SeasonGrid: a control shown to an anon viewer must not refuse (#762)", () => {
	// The defect class, swept rather than patched: three of this grid's writes
	// are session-gated (`clearAvailability` twice, `markUnavailableReleasing`
	// once) while every control reaching them keys on `currentMemberId` — which
	// is a localStorage name-pick on the public sheet.

	/** The viewer HOLDS a role in the only meeting, and has already declined in
	 *  the un-decline cases. `c1` is the member axis, so it is also the viewer. */
	const holdsRole: SeasonGridData = {
		...membersData,
		cells: [
			{
				slotId: "slot-1",
				meetingId: "m1",
				roleDefinitionId: "ti",
				slotIndex: 0,
				memberId: "c1",
				guestId: null,
				status: "claimed",
			},
		],
	};
	const declined: SeasonGridData = {
		...membersData,
		unavailable: [{ memberId: "c1", meetingId: "m1" }],
	};

	afterEach(() => {
		setAvailability.mockClear();
		clearAvailability.mockClear();
		markUnavailableReleasing.mockClear();
		toastSuccess.mockClear();
		toastError.mockClear();
	});

	it("a ROLE-HOLDER with no session records the answer instead of dead-ending", async () => {
		// The gap this closes. `markUnavailableReleasing` refuses an asserted
		// caller, and there was no fallback — so a member who picked their name on
		// the public sheet, holds Timer and taps "Can't go" was shown a dialog
		// promising a release and then told to sign in. The ANSWER was lost with
		// it. ADR-0026 permits that first answer explicitly; it is the release
		// that is withheld.
		await renderMembersGrid({
			data: holdsRole,
			currentMemberId: "c1",
			currentMemberSource: "anon",
			canManageOthers: false,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Can't go —/ }),
		);
		await waitFor(() => expect(setAvailability).toHaveBeenCalledTimes(1));
		expect(markUnavailableReleasing).not.toHaveBeenCalled();
		// And no confirm dialog: it exists to get consent for a release that is
		// not going to happen.
		expect(screen.queryByText(/Release &/)).toBeNull();
	});

	it("a ROLE-HOLDER with a session still gets the release confirm — the control", async () => {
		// Without this the fallback above would pass equally well with the
		// release removed from the grid entirely.
		await renderMembersGrid({
			data: holdsRole,
			currentMemberId: "c1",
			currentMemberSource: "session",
			canManageOthers: false,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Can't go —/ }),
		);
		expect(await screen.findByText(/Release &/)).toBeTruthy();
		expect(setAvailability).not.toHaveBeenCalled();
	});

	it("an ALREADY-DECLINED anon viewer keeps the state and loses the control", async () => {
		// Un-declining is `clearAvailability`, session-gated. The pill still says
		// "Not going" — it is the only thing on that column carrying the answer —
		// but it is no longer a button, so it cannot be tapped into a refusal by
		// mouse, keyboard or screen reader.
		await renderMembersGrid({
			data: declined,
			currentMemberId: "c1",
			currentMemberSource: "anon",
			canManageOthers: false,
		});
		expect(await screen.findByText("Not going")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Not going —/ })).toBeNull();
		expect(clearAvailability).not.toHaveBeenCalled();
	});

	it("the picker drops 'Mark yourself available' for an anon viewer", async () => {
		// The same write one affordance over: the cell's role picker carries the
		// un-decline as a menu row, and it is `clearAvailability` there too. Found
		// by sweeping the three session-gated writes rather than by patching the
		// sites the review named — the header chip and this row share one gate and
		// nothing but a sweep pairs them.
		await renderMembersGrid({
			data: declined,
			currentMemberId: "c1",
			currentMemberSource: "anon",
			canManageOthers: false,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Edit Carla Nguyen/ }),
		);
		expect(
			screen.queryByRole("button", { name: /mark yourself available/i }),
		).toBeNull();
		expect(clearAvailability).not.toHaveBeenCalled();
	});

	it("the picker KEEPS it for a signed-in viewer — the control", async () => {
		await renderMembersGrid({
			data: declined,
			currentMemberId: "c1",
			currentMemberSource: "session",
			canManageOthers: false,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Edit Carla Nguyen/ }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /mark yourself available/i }),
		);
		await waitFor(() => expect(clearAvailability).toHaveBeenCalledTimes(1));
	});

	it("an ALREADY-DECLINED signed-in viewer can still take it back", async () => {
		await renderMembersGrid({
			data: declined,
			currentMemberId: "c1",
			currentMemberSource: "session",
			canManageOthers: false,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Not going —/ }),
		);
		await waitFor(() => expect(clearAvailability).toHaveBeenCalledTimes(1));
	});
});

describe("SeasonGrid: the Undo after a clear follows what the clear did", () => {
	// `clearAvailability` REPORTS `cleared`. An officer's clear of another
	// member's row removes a decline and nothing else, so a grid still showing a
	// decline over an answer that has since changed deletes nothing; the Undo on
	// that toast would re-decline over the newer answer.
	const declined: SeasonGridData = {
		...membersData,
		unavailable: [{ memberId: "c1", meetingId: "m1" }],
	};

	afterEach(() => {
		setAvailability.mockClear();
		clearAvailability.mockClear();
		toastSuccess.mockClear();
		toastMessage.mockClear();
		toastError.mockClear();
	});

	/** An officer on the grid takes Carla's decline back from the cell menu. */
	async function officerClearsCarla(onChanged = vi.fn()) {
		await renderMembersGrid({
			data: declined,
			currentMemberId: "admin-1",
			currentMemberSource: "session",
			canManageOthers: true,
			onChanged,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Edit Carla Nguyen/ }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /mark them available/i }),
		);
		await waitFor(() => expect(clearAvailability).toHaveBeenCalledTimes(1));
		return onChanged;
	}

	it("offers Undo when the clear removed the decline, and Undo re-declines", async () => {
		// The control: the undo is the product, and a gate that removed it for
		// everyone would satisfy the negative below.
		const onChanged = await officerClearsCarla();
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess.mock.calls[0]?.[0]).toBe("Marked them available.");
		expect(toastMessage).not.toHaveBeenCalled();
		expect(onChanged).toHaveBeenCalledTimes(1);
		const options = toastSuccess.mock.calls[0]?.[1] as {
			action?: { label: string; onClick: () => void };
		};
		expect(options.action?.label).toBe("Undo");
		options.action?.onClick();
		await waitFor(() => expect(setAvailability).toHaveBeenCalledTimes(1));
		expect(setAvailability.mock.calls[0]).toMatchObject([
			{ data: { memberId: "c1", meetingId: "m1" } },
		]);
	});

	it("says nothing changed and offers NO Undo when the clear removed nothing", async () => {
		clearAvailability.mockResolvedValueOnce({ ok: true, cleared: false });
		const onChanged = await officerClearsCarla();
		await waitFor(() => expect(toastMessage).toHaveBeenCalledTimes(1));
		expect(toastMessage.mock.calls[0]?.[0]).toBe(
			"Nothing changed. Their answer changed since this page loaded.",
		);
		// No second argument at all: there is no action to tap, so the member's
		// newer answer cannot be overwritten from this toast.
		expect(toastMessage.mock.calls[0]).toHaveLength(1);
		// Not the success toast, which carries the Undo.
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(setAvailability).not.toHaveBeenCalled();
		// The grid refreshes, so the person sees the row as it now stands.
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it("says 'Your answer' for the viewer's own row", async () => {
		clearAvailability.mockResolvedValueOnce({ ok: true, cleared: false });
		await renderMembersGrid({
			data: declined,
			currentMemberId: "c1",
			currentMemberSource: "session",
			canManageOthers: false,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Not going —/ }),
		);
		await waitFor(() => expect(toastMessage).toHaveBeenCalledTimes(1));
		expect(toastMessage.mock.calls[0]?.[0]).toBe(
			"Nothing changed. Your answer changed since this page loaded.",
		);
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("treats a reply with no `cleared` as the clear that landed", async () => {
		// A server from before `cleared` existed answers a bare `{ ok: true }`
		// while a deploy overlaps. Only an explicit `false` means nothing was
		// removed; reading a missing field as `false` would tell an officer
		// "nothing changed" about a clear that worked.
		clearAvailability.mockResolvedValueOnce({ ok: true } as unknown as {
			ok: true;
			cleared: boolean;
		});
		await officerClearsCarla();
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess.mock.calls[0]?.[0]).toBe("Marked them available.");
		expect(toastMessage).not.toHaveBeenCalled();
	});
});

describe("SeasonGrid legend (#542, F-008)", () => {
	// Matches one <span> whose full normalized text is `text` — the legend
	// entries pair a short code with its decoded label in a single span. The
	// matcher reads `el.textContent` (not the `content` arg): testing-library
	// hands the matcher only the element's DIRECT text nodes, and the short
	// code sits in a nested <span>.
	const normalized = (el: Element | null) =>
		el?.textContent?.replace(/\s+/g, " ").trim();
	const legendEntry = (text: string) =>
		screen.getByText(
			(_, el) => el?.tagName === "SPAN" && normalized(el) === text,
		);

	it("decodes the Members × Meetings short codes under the grid", async () => {
		await renderMembersGrid();
		expect(legendEntry("Time Timer")).toBeTruthy();
		expect(legendEntry("NA Not available")).toBeTruthy();
		expect(legendEntry("· Free")).toBeTruthy();
	});

	it("shows no legend in the roles orientation — cells spell out full names there", async () => {
		await renderGrid(vi.fn(async () => null));
		expect(
			screen.queryByText(
				(_, el) =>
					el?.tagName === "SPAN" && normalized(el) === "NA Not available",
			),
		).toBeNull();
	});
});

describe("SeasonGrid open-cell hover affordance (#542, F-008)", () => {
	it("keeps both the resting '·' and the hover '+' in an editable free cell, swapped by the cell group", async () => {
		await renderMembersGrid();
		// Carla's cell for the upcoming meeting is the editable free-cell branch
		// (same cell the #340 test reaches).
		const cell = screen.getByRole("button", { name: /Edit Carla Nguyen/ });
		// The swap is CSS-only (group-hover), so jsdom can assert structure, not
		// paint: both elements must be in the DOM, wired to the SAME cell group.
		expect(cell.classList.contains("group/cell")).toBe(true);
		const dot = Array.from(cell.querySelectorAll("span")).find(
			(s) => s.textContent === "·",
		);
		expect(dot?.className).toContain("group-hover/cell:hidden");
		const plus = cell.querySelector("svg");
		expect(plus).toBeTruthy();
		expect(plus?.getAttribute("class") ?? "").toContain(
			"group-hover/cell:inline",
		);
	});
});

describe("SeasonGrid scroll-fade container split (#542, F-006)", () => {
	// jsdom performs no layout or paint, so the fade itself (mask + scroll-driven
	// animation in styles.css) is eyeball-QA at a phone width. What IS assertable
	// is the load-bearing structure: the mask class sits on the SCROLL container
	// and the border on a wrapper OUTSIDE it — a mask on the bordered element
	// would fade the border away, which is the exact bug the split avoids.
	it("puts the fade mask on the scroll container and the border on its wrapper", async () => {
		await renderMembersGrid();
		const scroller = document.querySelector(".scroll-fade-r");
		expect(scroller).toBeTruthy();
		expect(scroller?.classList.contains("overflow-auto")).toBe(true);
		expect(scroller?.querySelector("table")).toBeTruthy();
		expect(scroller?.classList.contains("border")).toBe(false);
		expect(scroller?.parentElement?.classList.contains("border")).toBe(true);
	});
});

describe("SeasonGrid contacted marker (#340)", () => {
	it("surfaces the contacted state on an editable free member cell, reachably and accessibly", async () => {
		await renderMembersGrid();

		// Reachable: the editable-button branch (not GridCell) renders for this
		// admin-viewed, upcoming, members-orientation cell. Accessible: the
		// contacted state is folded into the button's aria-label, not just the
		// aria-hidden dot.
		expect(screen.getByRole("button", { name: /contacted/i })).toBeTruthy();
	});
});

describe("SeasonGrid contact column", () => {
	// Scoped to the member's own <tr>. A grid-wide `getByText("—")` only proves
	// an em dash exists SOMEWHERE — it would pass on the neighbouring Email cell
	// while the Phone cell rendered blank.
	const rowFor = (name: string | RegExp) =>
		within(screen.getByRole("row", { name }));

	it("renders the member's phone as a WhatsApp link, not a dialer link", async () => {
		await renderContactGrid();

		const link = rowFor(/Carla Nguyen/).getByRole("link", {
			name: /\+14155552671/,
		});
		const href = link.getAttribute("href") ?? "";
		expect(href).toContain("whatsapp");
		expect(href).not.toContain("tel:");
		// Names the destination: the sign-up sheet is a wall of rows, so the number
		// alone doesn't say whose chat is about to open.
		expect(link.getAttribute("title")).toBe("Message Carla Nguyen on WhatsApp");
	});

	it("shows the em-dash fallback for a member with no number", async () => {
		await renderContactGrid();
		const row = rowFor(/Dev Patel/);

		// Dev carries an email, so the one em dash in HIS row is the empty phone
		// cell — an absent number must not leave the cell blank. `getByText` throws
		// on more than one match, which is what pins it to the phone cell.
		expect(row.getByText("—")).toBeTruthy();
		expect(row.queryByRole("link", { name: /WhatsApp/i })).toBeNull();
		// The email cell is still populated, so the em dash above cannot be it.
		expect(row.getByRole("link", { name: "dev@example.com" })).toBeTruthy();
	});

	it("puts the number under the Phone header, not the Email one", async () => {
		await renderContactGrid();

		// Row scoping alone cannot see WHICH column a cell sits in: swapping the
		// two <th> labels leaves every other assertion in this file green. Pin the
		// last header to the last cell — Phone is the final contact column.
		const headers = within(screen.getAllByRole("row")[0] as HTMLElement)
			.getAllByRole("columnheader")
			.map((h) => h.textContent);
		expect(headers.at(-1)).toBe("Phone");
		expect(headers.at(-2)).toBe("Email");

		const cells = rowFor(/Carla Nguyen/).getAllByRole("cell");
		expect(
			within(cells.at(-1) as HTMLElement).getByRole("link", {
				name: /\+14155552671/,
			}),
		).toBeTruthy();
	});
});

describe("Show past (#1048)", () => {
	/** Thirteen past meetings and the upcoming one — the widest lookback. */
	const PAST = 13;
	const wideData: SeasonGridData = {
		...contactData,
		meetings: [
			...Array.from({ length: PAST }, (_, i) => ({
				id: `p${i}`,
				scheduledAt: new Date(
					Date.parse("2026-03-05T19:00:00Z") + i * 7 * 24 * 60 * 60 * 1000,
				).toISOString(),
				timezone: "UTC",
				urlKey: `p${i}`,
				openCount: 0,
				totalSlots: 1,
				isPast: true,
				isAnchor: false,
				isCompleted: false,
			})),
			...data.meetings,
		],
	};

	it("is absent when the caller gives no handler — the public sheet", async () => {
		await renderUnderMemoryRouter(
			<SeasonGrid data={data} orientation="roles" count={8} />,
		);
		expect(screen.queryByText("Show past")).toBeNull();
		expect(screen.queryAllByRole("button", { name: /past meetings$/ })).toEqual(
			[],
		);
	});

	it("offers None, 2, 4, 8 and 13, marks the current one, and reports a pick", async () => {
		const onPastCountChange = vi.fn();
		await renderUnderMemoryRouter(
			<SeasonGrid
				data={data}
				orientation="roles"
				count={8}
				pastCount={8}
				onPastCountChange={onPastCountChange}
			/>,
		);
		const buttons = screen.getAllByRole("button", {
			name: /^Show (\d+|no) past meetings$/,
		});
		expect(buttons.map((b) => b.textContent)).toEqual([
			"None",
			"2",
			"4",
			"8",
			"13",
		]);
		expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
			"false",
			"false",
			"false",
			"true",
			"false",
		]);

		await userEvent.click(
			screen.getByRole("button", { name: "Show 13 past meetings" }),
		);
		expect(onPastCountChange).toHaveBeenCalledWith(13);
	});

	it("marks 2 as current when no pastCount is passed", async () => {
		await renderUnderMemoryRouter(
			<SeasonGrid
				data={data}
				orientation="roles"
				count={8}
				onPastCountChange={() => {}}
			/>,
		);
		expect(
			screen
				.getByRole("button", { name: "Show 2 past meetings" })
				.getAttribute("aria-pressed"),
		).toBe("true");
	});

	// protects=pastCount=0 shows no past column and the first column is the
	// first upcoming meeting; a pick of None is reported as 0;
	// fails_when=the grid renders every past column it was sent, as before #1316;
	// no_claim=layout (season-grid-geometry.test.ts).
	it("pastCount=0 renders no past column and reports None as 0", async () => {
		const onPastCountChange = vi.fn();
		await renderUnderMemoryRouter(
			<SeasonGrid
				data={wideData}
				orientation="roles"
				count={8}
				pastCount={0}
				onPastCountChange={onPastCountChange}
			/>,
		);
		const heads = screen
			.getAllByRole("columnheader")
			.filter((th) => /ended|open|full/.test(th.textContent ?? ""));
		expect(heads).toHaveLength(1);
		expect(heads[0]?.textContent).not.toContain("ended");
		await userEvent.click(
			screen.getByRole("button", { name: "Show no past meetings" }),
		);
		expect(onPastCountChange).toHaveBeenCalledWith(0);
	});

	it("pastCount=2 keeps the two most recent past columns of thirteen", async () => {
		await renderUnderMemoryRouter(
			<SeasonGrid
				data={wideData}
				orientation="roles"
				count={8}
				pastCount={2}
			/>,
		);
		const past = screen
			.getAllByRole("columnheader")
			.filter((th) => th.textContent?.includes("ended"));
		expect(past).toHaveLength(2);
	});

	// protects=a phone hydrates with the desktop default of 2 past columns and
	// then drops them: the anchor scroll must run again, or scrollLeft keeps
	// the two-column offset and hides the first upcoming meeting (#1316);
	// fails_when=the anchor-scroll effect depends on [] again.
	it("re-runs the anchor scroll when the rendered past columns change", async () => {
		function Harness() {
			const [n, setN] = useState<0 | 2>(2);
			return (
				<>
					<button type="button" onClick={() => setN(0)}>
						drop past
					</button>
					<SeasonGrid
						data={wideData}
						orientation="roles"
						count={8}
						pastCount={n}
					/>
				</>
			);
		}
		await renderUnderMemoryRouter(<Harness />);
		anchorScroll.mockClear();
		await userEvent.click(screen.getByRole("button", { name: "drop past" }));
		expect(anchorScroll).toHaveBeenCalledTimes(1);
	});

	// protects=a long member name is truncated inside the label column and its
	// full text is on `title`;
	// fails_when=the label loses `truncate` (a long name widens the column) or
	// the title (the name becomes unreachable);
	// no_claim=the 144px width itself, which only a browser measures.
	it("a label truncates and carries its full name in title", async () => {
		const long = "Bartholomew Montgomery-Featherstonehaugh III";
		await renderUnderMemoryRouter(
			<SeasonGrid
				data={{
					...membersData,
					members: [{ id: "c1", name: long }],
					memberNames: [{ id: "c1", name: long }],
				}}
				orientation="members"
				count={8}
			/>,
		);
		const label = screen.getByTitle(long);
		expect(label.className).toContain("truncate");
		expect(label.closest("th")?.className).toContain("max-w-36");
		expect(label.closest("th")?.className).not.toContain("text-right");
	});

	it.each([
		"roles",
		"members",
	] as const)("the %s orientation renders all 13 past columns, still muted", async (orientation) => {
		await renderUnderMemoryRouter(
			<SeasonGrid
				data={wideData}
				orientation={orientation}
				count={8}
				pastCount={13}
				currentMemberId="admin-1"
				currentMemberSource="session"
				canManageOthers
				showContact
				clubId="club-1"
				onPastCountChange={() => {}}
			/>,
		);
		const heads = screen
			.getAllByRole("columnheader")
			.filter((th) => /ended|open|full/.test(th.textContent ?? ""));
		expect(heads).toHaveLength(PAST + 1);
		const past = heads.filter((th) => th.textContent?.includes("ended"));
		expect(past).toHaveLength(PAST);
		for (const th of past) expect(th.className).toContain("opacity-45");
		// The upcoming column is not muted.
		expect(heads.at(-1)?.className).not.toContain("opacity-45");
		// Every body row carries exactly one cell per meeting column. The row's
		// label is a <th> (a rowheader, not a cell); the members orientation
		// adds the two contact cells (Email, Phone) after the meetings.
		const contactCells = orientation === "members" ? 2 : 0;
		const firstRow = screen.getAllByRole("row")[1];
		expect(within(firstRow as HTMLElement).getAllByRole("cell")).toHaveLength(
			PAST + 1 + contactCells,
		);
	});
});

// #1280. protects=a member freeing their OWN role is told the duty is still theirs, and an officer acting on someone else's keeps the byte-identical officer copy; fails_when=self copy drops the duty or uses the officer sentence, or the officer variant gains duty text; no_claim=mocked server writes and sonner; the viewer-is-holder rule is exercised through the season grid, not through each other release surface
describe("SeasonGrid: role-duty copy on release (#1280)", () => {
	const held = (memberId: string): SeasonGridData => ({
		...membersData,
		cells: [
			{
				slotId: "slot-1",
				meetingId: "m1",
				roleDefinitionId: "ti",
				slotIndex: 0,
				memberId,
				guestId: null,
				status: "claimed",
			},
		],
	});

	afterEach(() => {
		markUnavailableReleasing.mockClear();
		releaseSlot.mockClear();
		toastSuccess.mockClear();
	});

	// protects=self release-and-mark confirm states the duty and the toast is Role freed for 10s; fails_when=duty dropped or default duration; no_claim=mocked server writes and sonner
	it("self release-and-mark: confirm states the duty, toast is Role freed for 10s", async () => {
		await renderMembersGrid({
			data: held("c1"),
			currentMemberId: "c1",
			currentMemberSource: "session",
			canManageOthers: false,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Can't go —/ }),
		);
		expect(
			await screen.findByText(
				/it's still on you to find a replacement or tell the Toastmaster or VPE/,
			),
		).toBeTruthy();
		await userEvent.click(
			screen.getByRole("button", { name: /Release & mark unavailable/ }),
		);
		await waitFor(() =>
			expect(toastSuccess).toHaveBeenCalledWith(ROLE_FREED_DUTY_TEXT, {
				duration: 10_000,
			}),
		);
	});

	// protects=officer-on-behalf toast stays the byte-identical officer sentence; fails_when=officer variant gains duty text; no_claim=mocked writes
	it("officer marking someone else unavailable keeps the officer sentence", async () => {
		await renderMembersGrid({
			data: held("c1"),
			currentMemberId: "admin-1",
			currentMemberSource: "session",
			canManageOthers: true,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Edit Carla Nguyen/ }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /mark them not available/i }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /Release & mark unavailable/ }),
		);
		await waitFor(() =>
			expect(toastSuccess).toHaveBeenCalledWith(
				"Role released — they're marked unavailable.",
			),
		);
	});

	// protects=releasing your own cell reads Role freed for 10s; fails_when=old "Role released." returns or duration is default; no_claim=only the own-cell path is wired to release
	it("releasing your own cell shows Role freed with the duty", async () => {
		await renderGrid(undefined, {
			data: held("c1"),
			currentMemberId: "c1",
			currentMemberSource: "session",
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Release / }),
		);
		await waitFor(() =>
			expect(toastSuccess.mock.calls[0]?.[0]).toBe(ROLE_FREED_DUTY_TEXT),
		);
		expect(toastSuccess.mock.calls[0]?.[1]?.duration).toBe(10_000);
	});
	// protects=a self release-and-mark that frees nothing reads the no-role not-coming text; fails_when=it reads "Roles freed." or carries duty text; no_claim=released:0 is mocked
	it("self release-and-mark that freed nothing shows the plain not-coming toast", async () => {
		markUnavailableReleasing.mockResolvedValueOnce({ ok: true, released: 0 });
		await renderMembersGrid({
			data: held("c1"),
			currentMemberId: "c1",
			currentMemberSource: "session",
			canManageOthers: false,
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Can't go —/ }),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: /Release & mark unavailable/ }),
		);
		await waitFor(() =>
			expect(toastSuccess).toHaveBeenCalledWith(NOT_COMING_NO_ROLE_TEXT, {
				duration: undefined,
			}),
		);
	});

	// protects=picker release says Role freed to the holder and the old line to an officer; fails_when=an officer sees duty text or the holder does not; no_claim=exercised through the grid, not the standalone picker
	it("picker release: self sees Role freed, an officer releasing another's role sees the old line", async () => {
		for (const [viewer, expected] of [
			["c1", ROLE_FREED_DUTY_TEXT],
			["admin-1", "Released Timer."],
		] as const) {
			cleanup();
			toastSuccess.mockClear();
			await renderMembersGrid({
				data: held("c1"),
				currentMemberId: viewer,
				currentMemberSource: "session",
				canManageOthers: viewer !== "c1",
			});
			await userEvent.click(
				await screen.findByRole("button", { name: /^Edit Carla Nguyen/ }),
			);
			await userEvent.click(
				await screen.findByRole("button", { name: /Timer/ }),
			);
			await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
			expect(toastSuccess.mock.calls[0]?.[0]).toBe(expected);
		}
	});
});

describe("SeasonGrid: optimistic claim and release (#1315)", () => {
	const ME = "me-1";
	const withHolder = (memberId: string | null): SeasonGridData => ({
		...data,
		meetings: [{ ...data.meetings[0]!, openCount: memberId ? 0 : 1 }],
		memberNames: [{ id: ME, name: "Mia Mine" }],
		cells: [
			{
				slotId: "slot-1",
				meetingId: "m1",
				roleDefinitionId: "ti",
				slotIndex: 0,
				memberId,
				guestId: null,
				status: memberId ? "claimed" : "open",
			},
		],
	});
	const twoOpen: SeasonGridData = {
		...withHolder(null),
		meetings: [{ ...data.meetings[0]!, openCount: 2 }],
		rows: [
			...data.rows,
			{
				roleDefinitionId: "ah",
				slotIndex: 0,
				label: "Ah-Counter",
				shortCode: "Ah",
				sortOrder: 1,
				isSpeakerRole: false,
			},
		],
		cells: [
			...withHolder(null).cells,
			{
				slotId: "slot-2",
				meetingId: "m1",
				roleDefinitionId: "ah",
				slotIndex: 0,
				memberId: null,
				guestId: null,
				status: "open",
			},
		],
	};
	const deferred = <T,>() => {
		let resolve!: (v: T) => void;
		let reject!: (e: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	};

	afterEach(() => {
		claimSlot.mockReset();
		claimSlot.mockResolvedValue({ ok: true, proof: "session" });
		releaseSlot.mockReset();
		releaseSlot.mockResolvedValue({ ok: true });
		toastSuccess.mockClear();
		toastError.mockClear();
	});

	const mount = (d: SeasonGridData, onChanged?: () => Promise<void>) =>
		renderUnderMemoryRouter(
			<SeasonGrid
				data={d}
				orientation="roles"
				count="all"
				currentMemberId={ME}
				currentMemberSource="session"
				onChanged={onChanged}
			/>,
		);

	// protects=a tap shows the claim at once; fails_when=the cell waits for the server or keeps a spinner; no_claim=server-side count is not exercised
	it("fills the cell as mine and ticks the count down while claimSlot is unresolved", async () => {
		const d = deferred<{ ok: true; proof: "session" }>();
		claimSlot.mockReturnValueOnce(d.promise);
		await mount(twoOpen);
		expect(screen.getByText("2 open")).toBeTruthy();
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		const cellBtn = await screen.findByRole("button", {
			name: /^Claiming Timer/,
		});
		expect(cellBtn.getAttribute("aria-busy")).toBe("true");
		expect(cellBtn.className).toContain("bg-success");
		expect(cellBtn.querySelector("svg.lucide-check")).not.toBeNull();
		expect(cellBtn.querySelector(".animate-spin")).toBeNull();
		expect(cellBtn.textContent).toContain("Mia Mine");
		expect(screen.getByText("1 open")).toBeTruthy();
		await act(async () => d.resolve({ ok: true, proof: "session" }));
	});

	// protects=a failed claim restores the cell and count; fails_when=the optimistic fill sticks; no_claim=none
	it("rolls back the cell and count and shows the error when claimSlot rejects", async () => {
		const d = deferred<{ ok: true; proof: "session" }>();
		claimSlot.mockReturnValueOnce(d.promise);
		await mount(twoOpen);
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		expect(await screen.findByText("1 open")).toBeTruthy();
		await act(async () => d.reject(new Error("Slot taken")));
		await screen.findByText("2 open");
		expect(screen.getByRole("button", { name: /^Claim Timer/ })).toBeTruthy();
		expect(toastError).toHaveBeenCalledWith("Slot taken");
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	// protects=a dismissed picker changes nothing; fails_when=the cell fills before identity is known; no_claim=none
	it("changes nothing when the identity picker is dismissed", async () => {
		await renderGrid(vi.fn(async () => null));
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		expect(screen.getByText("1 open")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Claiming/ })).toBeNull();
		expect(claimSlot).not.toHaveBeenCalled();
	});

	// protects=release shows the role freed at once; fails_when=count stays or spinner shows; no_claim=none
	it("release ticks the count up as an open Claim cell, and restores on rejection", async () => {
		const d = deferred<{ ok: true }>();
		releaseSlot.mockReturnValueOnce(d.promise);
		await mount(withHolder(ME));
		expect(screen.getByText("full")).toBeTruthy();
		await userEvent.click(
			await screen.findByRole("button", { name: /^Release / }),
		);
		const cellBtn = await screen.findByRole("button", {
			name: /^Releasing /,
		});
		expect(cellBtn.getAttribute("aria-busy")).toBe("true");
		expect(cellBtn.textContent).toBe("Claim");
		expect(screen.getByText("1 open")).toBeTruthy();
		await act(async () => d.reject(new Error("nope")));
		await screen.findByText("full");
		expect(screen.getByRole("button", { name: /^Release / })).toBeTruthy();
		expect(toastError).toHaveBeenCalledWith("nope");
	});

	// protects=the column reads full when the optimistic count reaches 0; fails_when=a stale 0 open or negative; no_claim=none
	it("reads full when the optimistic count reaches 0", async () => {
		const d = deferred<{ ok: true; proof: "session" }>();
		claimSlot.mockReturnValueOnce(d.promise);
		await mount(withHolder(null));
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		expect(await screen.findByText("full")).toBeTruthy();
		await act(async () => d.resolve({ ok: true, proof: "session" }));
	});

	// protects=claiming the meeting's last open role thanks the claimer and keeps Undo; fails_when=the plain toast shows, or Undo is lost; no_claim=concurrent claims (best-effort, client-side)
	it("claiming the last open role says every role is filled, with Undo", async () => {
		await mount(withHolder(null));
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		const [msg, options] = toastSuccess.mock.calls[0];
		expect(msg).toMatch(/^That's every role filled for .+\. Thank you\.$/);
		expect(options.action.label).toBe("Undo");
	});

	// protects=a claim that leaves a role open keeps the plain toast; fails_when=the every-role toast shows with one still open; no_claim=none
	it("claiming a non-last role says Role claimed.", async () => {
		await mount(twoOpen);
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastSuccess.mock.calls[0]?.[0]).toBe("Role claimed.");
	});

	// protects=a failed refetch is not a claim error; fails_when=the error toast shows or the entry sticks; no_claim=the refetch itself
	it("a refetch that fails after a successful claim shows the success toast, no error, and clears the entry", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await mount(twoOpen, async () => {
			throw new Error("refetch down");
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		await waitFor(() =>
			expect(toastSuccess.mock.calls[0]?.[0]).toBe("Role claimed."),
		);
		expect(toastError).not.toHaveBeenCalled();
		// Loader data never changed, so with the entry cleared the cell is open.
		await screen.findByText("2 open");
		expect(screen.queryByRole("button", { name: /^Claiming/ })).toBeNull();
		consoleError.mockRestore();
	});

	// protects=fresh loader data does not double-count a still-pending entry; fails_when=count drops by two; no_claim=none
	it("lowers the count by exactly one when loader data already shows the claim and the entry is pending", async () => {
		const d = deferred<{ ok: true; proof: "session" }>();
		claimSlot.mockReturnValueOnce(d.promise);
		let setData!: (d: SeasonGridData) => void;
		function Harness() {
			const [cur, set] = useState(twoOpen);
			setData = set;
			return (
				<SeasonGrid
					data={cur}
					orientation="roles"
					count="all"
					currentMemberId={ME}
					currentMemberSource="session"
				/>
			);
		}
		await renderUnderMemoryRouter(<Harness />);
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		expect(await screen.findByText("1 open")).toBeTruthy();
		const claimed: SeasonGridData = {
			...twoOpen,
			meetings: [{ ...twoOpen.meetings[0]!, openCount: 1 }],
			cells: twoOpen.cells.map((c) =>
				c.slotId === "slot-1" ? { ...c, memberId: ME, status: "claimed" } : c,
			),
		};
		act(() => setData(claimed));
		expect(screen.getByText("1 open")).toBeTruthy();
		await act(async () => d.resolve({ ok: true, proof: "session" }));
	});

	// A grid whose loader data a test can swap, like a router refetch would.
	const mountSwappable = async (
		initial: SeasonGridData,
		onChanged?: () => Promise<void>,
	) => {
		let setData!: (d: SeasonGridData) => void;
		function Harness() {
			const [cur, set] = useState(initial);
			setData = set;
			return (
				<SeasonGrid
					data={cur}
					orientation="roles"
					count="all"
					currentMemberId={ME}
					currentMemberSource="session"
					onChanged={onChanged}
				/>
			);
		}
		await renderUnderMemoryRouter(<Harness />);
		return (d: SeasonGridData) => act(() => setData(d));
	};
	const undoFromLastToast = () => {
		const calls = toastSuccess.mock.calls;
		const [, options] = calls[calls.length - 1]!;
		expect(options.action.label).toBe("Undo");
		// Fire and forget: the write is deliberately left unresolved by callers.
		act(() => {
			void options.action.onClick();
		});
	};

	// protects=claimingRef: a second tap while the identity picker is open does not fire a second claim; fails_when=claimingRef is not consulted; no_claim=none
	it("a second tap while the identity picker is open claims once", async () => {
		const picker = deferred<StoredMember | null>();
		await renderGrid(() => picker.promise);
		const btn = await screen.findByRole("button", { name: /^Claim Timer/ });
		await userEvent.click(btn);
		await userEvent.click(btn);
		await act(async () => picker.resolve(PICKED));
		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(1));
	});

	// protects=the open count never reads negative; fails_when=Math.max(0, ..) is dropped; no_claim=none
	it("clamps the open count at 0 when stale data would take it negative", async () => {
		const d = deferred<{ ok: true; proof: "session" }>();
		claimSlot.mockReturnValueOnce(d.promise);
		const stale: SeasonGridData = {
			...withHolder(null),
			meetings: [{ ...data.meetings[0]!, openCount: 0 }],
		};
		await mount(stale);
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		await screen.findByRole("button", { name: /^Claiming Timer/ });
		expect(screen.queryByText("-1 open")).toBeNull();
		expect(screen.getByText("full")).toBeTruthy();
		await act(async () => d.resolve({ ok: true, proof: "session" }));
	});

	// protects=a pending release whose result loader data already shows does not raise the count twice; fails_when=the release entry applies against an already-open slot; no_claim=none
	it("raises the count by one, not two, when loader data already shows the release", async () => {
		const d = deferred<{ ok: true }>();
		releaseSlot.mockReturnValueOnce(d.promise);
		const swap = await mountSwappable(withHolder(ME));
		await userEvent.click(
			await screen.findByRole("button", { name: /^Release / }),
		);
		expect(await screen.findByText("1 open")).toBeTruthy();
		await swap(withHolder(null));
		expect(screen.getByText("1 open")).toBeTruthy();
		// Loader data has taken over: the entry no longer applies to the cell.
		expect(screen.queryByRole("button", { name: /^Releasing/ })).toBeNull();
		await act(async () => d.resolve({ ok: true }));
	});

	// protects=a failed refetch is not a release error; fails_when=the error toast shows or the entry sticks; no_claim=none
	it("a refetch that fails after a successful release shows the success toast, no error, and clears the entry", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await mount(withHolder(ME), async () => {
			throw new Error("refetch down");
		});
		await userEvent.click(
			await screen.findByRole("button", { name: /^Release / }),
		);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastError).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /^Releasing/ })).toBeNull(),
		);
		expect(screen.getByRole("button", { name: /^Release / })).toBeTruthy();
		consoleError.mockRestore();
	});

	// protects=Undo tapped before the claim's refetch lands reads as releasing and is not a dead control; fails_when=a release over a stale-open slot renders a plain Claim; no_claim=none
	it("Undo during the claim's refetch shows an open, busy cell and an unchanged count", async () => {
		const refetch = deferred<void>();
		const release = deferred<{ ok: true }>();
		releaseSlot.mockReturnValueOnce(release.promise);
		await mount(twoOpen, () => refetch.promise);
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		await undoFromLastToast();
		const cellBtn = await screen.findByRole("button", {
			name: /^Releasing Timer/,
		});
		expect(cellBtn.getAttribute("aria-busy")).toBe("true");
		expect(cellBtn.textContent).toBe("Claim");
		expect(screen.getByText("2 open")).toBeTruthy();
		await act(async () => {
			release.resolve({ ok: true });
			refetch.resolve();
		});
	});

	// protects=claimingRef is freed once the claim write resolves, so Undo then claim works; fails_when=claimingRef is held through the refetch; no_claim=none
	it("a claim tapped again after Undo during the refetch is not swallowed", async () => {
		const refetch = deferred<void>();
		await mount(twoOpen, () => refetch.promise);
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		await undoFromLastToast();
		await waitFor(() => expect(releaseSlot).toHaveBeenCalledTimes(1));
		// The release's toast offers Undo = claim again.
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(2));
		await undoFromLastToast();
		await waitFor(() => expect(claimSlot).toHaveBeenCalledTimes(2));
		await act(async () => refetch.resolve());
	});

	// protects=endPending's identity check: an earlier write's finally does not clear a later write's entry; fails_when=endPending deletes whatever entry is there; no_claim=none
	it("the claim's late refetch does not clear the Undo's pending release", async () => {
		const refetch = deferred<void>();
		const release = deferred<{ ok: true }>();
		releaseSlot.mockReturnValueOnce(release.promise);
		await mount(twoOpen, () => refetch.promise);
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		await undoFromLastToast();
		await screen.findByRole("button", { name: /^Releasing Timer/ });
		// The claim's refetch finishes first: its finally must leave the release.
		await act(async () => refetch.resolve());
		expect(
			screen.getByRole("button", { name: /^Releasing Timer/ }),
		).toBeTruthy();
		await act(async () => release.resolve({ ok: true }));
	});

	// protects=criterion 2: a rejection with no user message still toasts the claim fallback; fails_when=the fallback string changes or is dropped; no_claim=none
	it("shows the claim fallback when the rejection carries no message", async () => {
		claimSlot.mockRejectedValueOnce("boom");
		await mount(twoOpen);
		await userEvent.click(
			await screen.findByRole("button", { name: /^Claim Timer/ }),
		);
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Couldn't claim role."),
		);
	});

	// protects=criterion 4: a rejection with no user message still toasts the release fallback; fails_when=the fallback string changes or is dropped; no_claim=none
	it("shows the release fallback when the rejection carries no message", async () => {
		releaseSlot.mockRejectedValueOnce("boom");
		await mount(withHolder(ME));
		await userEvent.click(
			await screen.findByRole("button", { name: /^Release / }),
		);
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Couldn't release role."),
		);
	});
});

describe("SeasonGrid sticky label column fills the border-spacing gap (#1302)", () => {
	// The table is border-separate with a 4px spacing, so a sticky cell's
	// background stops at its border box and whatever scrolls underneath shows
	// through the gap. The fix is a 4px spread shadow in the cell's own colour.
	// jsdom has no paint, so these assert the class strings on the RENDERED
	// cells (the contract), not the pixels; the real-paint check is the
	// Chrome-backed season-grid-sticky-gap test.
	const stickyLabelCells = () =>
		Array.from(document.querySelectorAll("table th")).filter(
			(th) =>
				th.classList.contains("sticky") && th.classList.contains("left-0"),
		);
	// A BASE (non-variant) arbitrary shadow: the class must start the token, so
	// `group-hover:shadow-[...]` never satisfies it.
	const baseShadow = (th: Element) =>
		th.className.match(/(?:^|\s)shadow-\[([^\]]*)\]/)?.[1] ?? "";
	const headerCell = () =>
		stickyLabelCells().find((th) => th.className.includes("top-0"));
	const bodyCells = () =>
		stickyLabelCells().filter((th) => !th.className.includes("top-0"));

	it.each([
		["roles", () => renderGrid(undefined, { currentMemberId: "admin-1" })],
		["members", () => renderMembersGrid()],
	])("header and every body label cell (%s view) carry their own-colour base spread", async (_n, mount) => {
		await mount();
		expect(headerCell()).toBeTruthy();
		expect(baseShadow(headerCell() as Element)).toContain(
			"0_0_0_4px_var(--card)",
		);
		const body = bodyCells();
		expect(body.length).toBeGreaterThan(0);
		for (const th of body) {
			const spread = baseShadow(th);
			// plain rows spread card; the self row spreads its tint (next test)
			expect(spread).toMatch(
				/0_0_0_4px_(var\(--card\)|color-mix\(in_oklab,var\(--card\),var\(--primary\)_8%\))/,
			);
		}
		// the spread must equal the table's spacing, or a sliver stays open
		expect(document.querySelector("table")?.className).toContain(
			"border-spacing-1",
		);
	});

	it("a plain body row at rest spreads var(--card) in its BASE shadow", async () => {
		await renderMembersGrid({ currentMemberId: "someone-else" });
		const plain = bodyCells().filter((th) =>
			th.className.includes("group-hover:bg-muted"),
		);
		expect(plain.length).toBeGreaterThan(0);
		for (const th of plain) {
			expect(baseShadow(th)).toContain("0_0_0_4px_var(--card)");
		}
	});

	it("the hover and self-row variants fill the gap in the colour they show", async () => {
		await renderMembersGrid({ currentMemberId: "someone-else" });
		const hover = bodyCells().filter((th) =>
			th.className.includes("group-hover:bg-muted"),
		);
		expect(hover.length).toBeGreaterThan(0);
		for (const th of hover) {
			expect(th.className).toMatch(
				/group-hover:shadow-\[[^\]]*0_0_0_4px_var\(--muted\)/,
			);
		}
		cleanup();
		await renderMembersGrid({ currentMemberId: "c1" });
		const tinted = bodyCells().filter((th) =>
			th.className.includes("color-mix"),
		);
		expect(tinted.length).toBe(1);
		const MIX = "color-mix(in_oklab,var(--card),var(--primary)_8%)";
		// bg and spread are the same colour, or the gap shows a different frame
		expect(tinted[0].className).toContain(`bg-[${MIX}]`);
		expect(baseShadow(tinted[0])).toContain(`0_0_0_4px_${MIX}`);
	});

	it("a hovered or self row's label cell outranks its neighbours' spread but not the header", async () => {
		await renderMembersGrid({ currentMemberId: "c1" });
		const z = (th: Element) =>
			th.className.match(/(?:^|\s)z-(\d+|\[\d+\])/)?.[1] ?? "";
		expect(z(headerCell() as Element)).toBe("20");
		const self = bodyCells().find((th) => th.className.includes("color-mix"));
		expect(z(self as Element)).toBe("[11]");
		cleanup();
		await renderMembersGrid({ currentMemberId: "someone-else" });
		const plain = bodyCells().find((th) =>
			th.className.includes("group-hover:bg-muted"),
		);
		expect(z(plain as Element)).toBe("10");
		expect(plain?.className).toContain("group-hover:z-[11]");
	});
});

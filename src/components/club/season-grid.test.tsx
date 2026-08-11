// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
async function renderMembersGrid() {
	const rootRoute = createRootRoute({
		component: () => (
			<SeasonGrid
				data={membersData}
				orientation="members"
				count="all"
				currentMemberId="admin-1"
				canManageOthers
				clubId="club-1"
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

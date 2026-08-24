// @vitest-environment jsdom
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaDraft } from "#/server/meeting-agenda-edit";
import { AgendaEditor } from "./agenda-editor";

afterEach(cleanup);

const draft: AgendaDraft = {
	templateId: "tpl-1",
	templateName: "Standard meeting",
	editable: true,
	// 6:45 PM America/Chicago, 90-minute booking — the shape the editor's clock
	// is computed from. Every timing assertion below reads off these.
	slots: [],
	scheduledAt: "2026-09-10T23:45:00.000Z",
	timeZone: "America/Chicago",
	lengthMinutes: 90,
	geIntroducesFunctionaries: false,
	rows: [
		{
			id: "r1",
			sortOrder: 0,
			kind: "section",
			label: "OPENING",
			detail: null,
			minutes: 0,
			roleKey: null,
			repeatsRoleKey: null,
			flex: false,
			markGreen: null,
			markYellow: null,
			markRed: null,
		},
		{
			id: "r2",
			sortOrder: 1,
			kind: "role",
			label: "Welcome",
			detail: null,
			minutes: 5,
			roleKey: "toastmaster",
			repeatsRoleKey: null,
			flex: false,
			markGreen: null,
			markYellow: null,
			markRed: null,
		},
	],
	roles: [
		{
			key: "toastmaster",
			name: "Toastmaster",
			category: "leadership",
			defaultCount: 1,
			isSpeakerRole: false,
		},
		{
			key: "zoom_master",
			name: "Zoom Master",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		},
	],
};

const noopHandlers = {
	// Returns a ROW: `onAddRow` hands back what it created so undo can patch the
	// deleted row's fields onto it.
	onAddRow: vi.fn().mockResolvedValue({
		id: "new-row",
		sortOrder: 0,
		kind: "role",
		label: "New item",
		detail: null,
		minutes: 0,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
	}),
	onUpdateRow: vi.fn().mockResolvedValue(undefined),
	onRemoveRow: vi.fn().mockResolvedValue(undefined),
	onMoveRow: vi.fn().mockResolvedValue(undefined),
	onAddRole: vi.fn().mockResolvedValue(undefined),
	planRoleRemoval: vi.fn().mockResolvedValue([]),
	onRemoveRole: vi.fn().mockResolvedValue(undefined),
};

/** Open a row's detail disclosure.
 *
 *  The note, the role binding, the per-holder flag and the three timing marks
 *  live behind a per-row toggle: a row has ten controls and the table has four
 *  columns, and widening it until they all fit pushes the running clock off the
 *  left edge on a laptop — the one thing the table exists to show. These tests
 *  therefore open the row first, which is what an officer does too. */
async function openRowDetail(index = 0) {
	const toggles = screen.getAllByRole("button", { name: /show row details/i });
	await userEvent.click(toggles[index] as HTMLElement);
}

describe("AgendaEditor", () => {
	it("renders one control row per agenda row, in order", () => {
		render(<AgendaEditor draft={draft} {...noopHandlers} />);
		const labels = screen.getAllByLabelText("Row label");
		expect(labels.map((el) => (el as HTMLInputElement).value)).toEqual([
			"OPENING",
			"Welcome",
		]);
	});

	it("hides every mutating control when the draft is not editable", () => {
		// A completed meeting's agenda is the record it became. The server refuses
		// the write regardless; this is so an officer is not offered a button that
		// will fail.
		render(
			<AgendaEditor draft={{ ...draft, editable: false }} {...noopHandlers} />,
		);
		expect(screen.queryByRole("button", { name: /add row/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
	});

	it("asks for confirmation and NAMES the holders before removing a role", async () => {
		const onRemoveRole = vi.fn();
		const planRoleRemoval = vi.fn().mockResolvedValue([
			{
				memberId: "m1",
				guestId: null,
				name: "Ada Lovelace",
				roleName: "Zoom Master",
			},
		]);
		render(
			<AgendaEditor
				draft={draft}
				{...noopHandlers}
				planRoleRemoval={planRoleRemoval}
				onRemoveRole={onRemoveRole}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: /remove zoom master/i }),
		);
		// jest-dom is not installed in this repo (see meeting-attendance-panel.test.tsx),
		// so `toBeInTheDocument` isn't available — `findByText` already throws if the
		// element never appears, and `toBeTruthy` is the convention used elsewhere here
		// (meeting-template-dialog.test.tsx).
		expect(await screen.findByText(/Ada Lovelace/)).toBeTruthy();
		// Not removed on ASKING.
		expect(onRemoveRole).not.toHaveBeenCalled();
		await userEvent.click(
			screen.getByRole("button", { name: /remove anyway/i }),
		);
		expect(onRemoveRole).toHaveBeenCalledWith("zoom_master");
	});

	/**
	 * D4's "unauthorable" guarantee, client half.
	 *
	 * `repeats_role_key` IS the once/per-holder flag, and a per-holder row must
	 * repeat over the EXACT role it names. The Role select used to patch
	 * `roleKey` alone, so ticking the per-holder box and then changing the Role
	 * — two clicks — left the row holding `roleKey = Y, repeatsRoleKey = X`.
	 * That row prints once per holder of X, numbered and naming nobody, while
	 * the editor's own label reads "One row".
	 *
	 * The server refuses that merge now, which is what makes this test about
	 * more than tidiness: patching one key alone would make the Role select
	 * simply FAIL on every per-holder row.
	 */
	const perHolderDraft: AgendaDraft = {
		...draft,
		// A per-holder row needs a SLOT to render. The editor shows the expanded
		// agenda — the same rows that print — and a repeat block whose role nobody
		// holds emits nothing at all. That is the honest rendering (an unheld
		// repeat prints nothing either), and it is why this fixture supplies one
		// holder where the `draft` above needs none: `draft.rows[1]` does not
		// repeat, so it emits one row regardless of who holds it.
		slots: [
			{
				id: "slot-tm",
				roleName: "Toastmaster",
				roleKey: "toastmaster",
				category: "leadership",
				isSpeakerRole: false,
				slotIndex: 0,
				assigneeName: "Ada Lovelace",
				speechTitle: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
				evaluatesSlotId: null,
				evaluates: null,
			},
		],
		rows: [
			{
				...(draft.rows[1] as AgendaDraft["rows"][number]),
				repeatsRoleKey: "toastmaster",
			},
		],
	};

	it("renders nothing for a per-holder row whose role nobody holds", () => {
		// The consequence of showing the EXPANDED agenda, pinned so it is a
		// decision rather than a surprise: an officer who ticks "one row per
		// person" on a role with no slots sees the row disappear, exactly as it
		// would disappear from the printed sheet.
		render(
			<AgendaEditor
				draft={{ ...perHolderDraft, slots: [] }}
				{...noopHandlers}
			/>,
		);
		expect(screen.queryAllByLabelText("Row label")).toHaveLength(0);
	});

	it("ticks per-holder by repeating over the row's OWN role, and unticks to null", async () => {
		// The checkbox is the other half of the pair the Role select has to stay in
		// step with, and nothing exercised it before this fix wave. It may only
		// ever write the row's own key — writing any other role's is the shape
		// `assertRepeatBinding` refuses at the writer.
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		const { unmount } = render(
			<AgendaEditor
				draft={draft}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		// By NAME, not by role alone: the add-role form has its own "Speaking
		// role" checkbox, and the label text is also what proves which state the
		// row is in.
		// The role row is the SECOND row (index 1); the first is the OPENING band.
		await openRowDetail(1);
		await userEvent.click(screen.getByRole("checkbox", { name: /^one row$/i }));
		await waitFor(() =>
			expect(onUpdateRow).toHaveBeenCalledWith("r2", {
				repeatsRoleKey: "toastmaster",
			}),
		);
		unmount();

		onUpdateRow.mockClear();
		render(
			<AgendaEditor
				draft={perHolderDraft}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		// `perHolderDraft` has ONE row, so its disclosure is the only one.
		await openRowDetail();
		await userEvent.click(
			screen.getByRole("checkbox", { name: /one row per person/i }),
		);
		await waitFor(() =>
			expect(onUpdateRow).toHaveBeenCalledWith("r2", { repeatsRoleKey: null }),
		);
	});

	it("moves both role keys together when a per-holder row changes role", async () => {
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor
				draft={perHolderDraft}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		// The label proves the fixture really is a per-holder row, so a future
		// change to how `perHolder` is derived cannot quietly turn this into a
		// test of the "once" path.
		await openRowDetail();
		expect(screen.getByText(/one row per person/i)).toBeTruthy();
		await userEvent.selectOptions(
			screen.getByLabelText("Row role"),
			"zoom_master",
		);
		await waitFor(() =>
			expect(onUpdateRow).toHaveBeenCalledWith("r2", {
				roleKey: "zoom_master",
				repeatsRoleKey: "zoom_master",
			}),
		);
	});

	it("clears both role keys when a per-holder row changes to Nobody", async () => {
		// Setting the Role to "Nobody" hides the per-holder checkbox, so a
		// `repeatsRoleKey` left behind here had no UI path to clear it — and the
		// row vanished from print, deck and pptx while still showing here.
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor
				draft={perHolderDraft}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		await openRowDetail();
		await userEvent.selectOptions(screen.getByLabelText("Row role"), "");
		await waitFor(() =>
			expect(onUpdateRow).toHaveBeenCalledWith("r2", {
				roleKey: null,
				repeatsRoleKey: null,
			}),
		);
	});

	it("re-seeds a rejected field from the row the server still holds", async () => {
		// `max={600}` stops the spinner, not a paste. When the server refuses the
		// value the toast fires, `router.invalidate()` re-renders the SAME
		// `row.id`, and React keeps the existing state — so without this the
		// field goes on showing a number the server never accepted, and the next
		// blur is a no-op because the field already "matches" itself.
		const onUpdateRow = vi
			.fn()
			.mockRejectedValue(new Error("Minutes must be between 0 and 600."));
		render(
			<AgendaEditor
				draft={draft}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		const minutes = screen.getByLabelText("Row minutes") as HTMLInputElement;
		expect(minutes.value).toBe("5");
		await userEvent.clear(minutes);
		await userEvent.type(minutes, "900");
		await userEvent.tab();
		await waitFor(() =>
			expect(onUpdateRow).toHaveBeenCalledWith("r2", { minutes: 900 }),
		);
		await waitFor(() => expect(minutes.value).toBe("5"));
	});

	it("does not confirm when nothing is claimed", async () => {
		// Friction scales with damage — a confirm on every change trains officers
		// to click through the one that matters.
		const onRemoveRole = vi.fn();
		const planRoleRemoval = vi.fn().mockResolvedValue([]);
		render(
			<AgendaEditor
				draft={draft}
				{...noopHandlers}
				planRoleRemoval={planRoleRemoval}
				onRemoveRole={onRemoveRole}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: /remove toastmaster/i }),
		);
		await waitFor(() =>
			expect(onRemoveRole).toHaveBeenCalledWith("toastmaster"),
		);
		// No second confirm ever appeared — a single click was enough.
		expect(screen.queryByRole("button", { name: /remove anyway/i })).toBeNull();
	});
});

describe("AgendaEditor running clock and budget", () => {
	it("stamps each row with its start time", () => {
		render(<AgendaEditor draft={draft} {...noopHandlers} />);
		// OPENING (0 min) then Welcome (5), from a 6:45 PM start: both start 6:45.
		expect(screen.getByTestId("agenda-row-start-0")?.textContent).toContain(
			"6:45",
		);
		expect(screen.getByTestId("agenda-row-start-1")?.textContent).toContain(
			"6:45",
		);
	});

	it("shows the end time, the total, the slot and the signed delta", () => {
		render(<AgendaEditor draft={draft} {...noopHandlers} />);
		const footer = screen.getByTestId("agenda-budget");
		expect(footer?.textContent).toContain("6:50");
		expect(footer?.textContent).toContain("5 min");
		expect(footer?.textContent).toContain("slot 90 min");
		expect(footer?.textContent).toContain("85 under");
	});

	it("states the delta INSIDE the ±2 tolerance and withholds the advice", () => {
		// The bug D5 exists to prevent: applyFlex reports "exact" within
		// FLEX_TOLERANCE_MINUTES, so a footer derived from `status` would say
		// nothing at all about a meeting 2 minutes over — which is precisely
		// MCF's contest.
		const tight: AgendaDraft = {
			...draft,
			lengthMinutes: 3,
			rows: [{ ...draft.rows[1], minutes: 5 }],
		};
		render(<AgendaEditor draft={tight} {...noopHandlers} />);
		expect(screen.getByTestId("agenda-budget")?.textContent).toContain(
			"2 over",
		);
		expect(screen.queryByTestId("agenda-budget-advice")).toBeNull();
	});

	it("renders the advisory sentence OUTSIDE the tolerance", () => {
		const late: AgendaDraft = {
			...draft,
			lengthMinutes: 3,
			rows: [{ ...draft.rows[1], minutes: 20 }],
		};
		render(<AgendaEditor draft={late} {...noopHandlers} />);
		expect(screen.getByTestId("agenda-budget-advice")?.textContent).toMatch(
			/runs 17 min long/,
		);
	});

	it("recomputes the clock as you type, before any save", async () => {
		const user = userEvent.setup();
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor
				draft={draft}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		const min = screen.getByLabelText("Row minutes");
		await user.clear(min);
		await user.type(min, "30");
		await waitFor(() => {
			expect(screen.getByTestId("agenda-budget")?.textContent).toContain(
				"7:15",
			);
		});
		// The whole point: no round-trip happened. The clock moved locally.
		expect(onUpdateRow).not.toHaveBeenCalled();
	});

	it("subtotals each section band", () => {
		render(<AgendaEditor draft={draft} {...noopHandlers} />);
		expect(screen.getByTestId("agenda-section-total-0")?.textContent).toContain(
			"5",
		);
	});

	it("still commits a minutes edit on blur", async () => {
		const user = userEvent.setup();
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor
				draft={draft}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		const min = screen.getByLabelText("Row minutes");
		await user.clear(min);
		await user.type(min, "9");
		await user.tab();
		await waitFor(() =>
			expect(onUpdateRow).toHaveBeenCalledWith("r2", { minutes: 9 }),
		);
	});
});

describe("AgendaEditor repeat blocks", () => {
	const NAMES = [
		"Faisal Ali",
		"Rehanna Khan",
		"Jagpal Singh",
		"Riyaz Mohammed",
	];

	/** MCF's contest shape: a two-beat block over N contestants. */
	function contestDraft(contestants: number): AgendaDraft {
		return {
			...draft,
			roles: [
				{
					key: "contestant",
					name: "Contestant",
					category: "speaker",
					defaultCount: contestants,
					isSpeakerRole: true,
				},
			],
			slots: NAMES.slice(0, contestants).map((name, i) => ({
				id: `c${i}`,
				roleName: "Contestant",
				roleKey: "contestant",
				category: "speaker" as const,
				isSpeakerRole: true,
				slotIndex: i,
				assigneeName: name,
				speechTitle: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
				evaluatesSlotId: null,
				evaluates: null,
			})),
			rows: [
				{
					id: "b-speech",
					sortOrder: 0,
					kind: "role",
					label: "Contest speech",
					detail: null,
					minutes: 7,
					roleKey: "contestant",
					repeatsRoleKey: "contestant",
					flex: false,
					markGreen: null,
					markYellow: null,
					markRed: null,
				},
				{
					id: "b-silence",
					sortOrder: 1,
					kind: "event",
					label: "One minute of silence",
					detail: null,
					minutes: 1,
					roleKey: null,
					repeatsRoleKey: "contestant",
					flex: false,
					markGreen: null,
					markYellow: null,
					markRed: null,
				},
			],
		};
	}

	it("edits band 1 and writes the SHARED beat exactly once", async () => {
		const user = userEvent.setup();
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor
				draft={contestDraft(4)}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		// Only iteration 1 is editable, so only its two rows expose a Min input.
		const mins = screen.getAllByLabelText("Row minutes");
		expect(mins).toHaveLength(2);
		await user.clear(mins[0] as HTMLElement);
		await user.type(mins[0] as HTMLElement, "5");
		await user.tab();
		// ONE call naming the shared beat — not four. Every contestant renders
		// from the same stored row, so four calls would mean four writes to the
		// same field.
		await waitFor(() => expect(onUpdateRow).toHaveBeenCalledTimes(1));
		expect(onUpdateRow).toHaveBeenCalledWith("b-speech", { minutes: 5 });
	});

	it("collapses contestants 2..N and exposes no control on them", () => {
		render(<AgendaEditor draft={contestDraft(4)} {...noopHandlers} />);
		const rest = screen.getByTestId("agenda-band-rest");
		// The span, so collapsing costs no timing information.
		expect(rest.textContent).toContain("6:53");
		expect(rest.textContent).toContain("7:17");
		// 3 contestants x (7 + 1).
		expect(rest.textContent).toContain("24");
		// Naming the ROLE, not "iteration" — and the club's own word for it.
		expect(rest.textContent).toMatch(/Contestant 2–4/);
	});

	it("expands contestants 2..N on request, still read-only", async () => {
		const user = userEvent.setup();
		render(<AgendaEditor draft={contestDraft(4)} {...noopHandlers} />);
		await user.click(
			screen.getByRole("button", { name: /show contestant 2–4/i }),
		);
		// Every contestant is now on screen by name...
		for (const name of NAMES.slice(1)) {
			expect(screen.getByText(name)).toBeTruthy();
		}
		// ...and still exactly two editable Min inputs, both on iteration 1.
		expect(screen.getAllByLabelText("Row minutes")).toHaveLength(2);
	});

	it("shows no band at a single arity", () => {
		render(<AgendaEditor draft={contestDraft(1)} {...noopHandlers} />);
		expect(screen.queryByTestId("agenda-band-rest")).toBeNull();
		// One contestant, two rows, both editable.
		expect(screen.getAllByLabelText("Row minutes")).toHaveLength(2);
	});

	it("counts every contestant in the budget, folded or not", () => {
		render(<AgendaEditor draft={contestDraft(4)} {...noopHandlers} />);
		// 4 x (7 + 1) = 32, whatever is drawn. Folding is display only.
		expect(screen.getByTestId("agenda-budget")?.textContent).toContain(
			"32 min",
		);
	});
});

describe("AgendaEditor stretchy row", () => {
	/** One fixed row and one that stretches, in a 40-minute slot. */
	const flexDraft: AgendaDraft = {
		...draft,
		lengthMinutes: 40,
		rows: [
			{
				...(draft.rows[1] as AgendaDraft["rows"][number]),
				id: "fixed",
				minutes: 10,
			},
			{
				...(draft.rows[1] as AgendaDraft["rows"][number]),
				id: "topics",
				label: "Table Topics",
				minutes: 10,
				flex: true,
			},
		],
	};

	it("renders the stretchy row's minutes as computed text, not an input", () => {
		render(<AgendaEditor draft={flexDraft} {...noopHandlers} />);
		const cell = screen.getByTestId("agenda-row-minutes-1");
		// 40-minute slot minus the 10-minute fixed row, clamped to the Table
		// Topics ceiling of 25.
		expect(cell.textContent).toContain("25");
		expect(cell.textContent).toMatch(/stretches 5.25/);
		// The point: NOT an input. `applyFlex` overwrites this row's minutes, so
		// a typed value would be discarded on the next render — a control that
		// accepts input and changes nothing is worse than no control.
		expect(within(cell).queryByRole("spinbutton")).toBeNull();
	});

	it("counts the STRETCHED minutes in the budget, not the stored ones", () => {
		render(<AgendaEditor draft={flexDraft} {...noopHandlers} />);
		// 10 fixed + 25 stretched = 35, against a 40-minute slot.
		const footer = screen.getByTestId("agenda-budget");
		expect(footer.textContent).toContain("35 min");
		expect(footer.textContent).toContain("5 under");
	});

	it("pins a stretchy row with flex:false and nothing else", async () => {
		const user = userEvent.setup();
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor
				draft={flexDraft}
				{...noopHandlers}
				onUpdateRow={onUpdateRow}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /^pin$/i }));
		await waitFor(() =>
			expect(onUpdateRow).toHaveBeenCalledWith("topics", { flex: false }),
		);
	});

	it("gives a pinned row an ordinary editable cell", () => {
		const pinned: AgendaDraft = {
			...flexDraft,
			rows: flexDraft.rows.map((r) => ({ ...r, flex: false })),
		};
		render(<AgendaEditor draft={pinned} {...noopHandlers} />);
		expect(screen.getAllByLabelText("Row minutes")).toHaveLength(2);
		expect(screen.queryByRole("button", { name: /^pin$/i })).toBeNull();
	});

	it("offers Make stretchy only while NO row already stretches", async () => {
		const user = userEvent.setup();
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		const none: AgendaDraft = {
			...flexDraft,
			rows: flexDraft.rows.map((r) => ({ ...r, flex: false })),
		};
		const { unmount } = render(
			<AgendaEditor draft={none} {...noopHandlers} onUpdateRow={onUpdateRow} />,
		);
		// Nothing stretches yet, so every row may volunteer.
		expect(
			screen.getAllByRole("button", { name: /make stretchy/i }),
		).toHaveLength(2);
		await user.click(
			screen.getAllByRole("button", {
				name: /make stretchy/i,
			})[0] as HTMLElement,
		);
		await waitFor(() =>
			expect(onUpdateRow).toHaveBeenCalledWith("fixed", { flex: true }),
		);
		unmount();

		// With one already stretching, the offer is withdrawn from the others:
		// schema.ts states at most one flex beat per template, and two would have
		// applyFlex splitting the slack between them — legal in the database,
		// meaningless on the page.
		render(<AgendaEditor draft={flexDraft} {...noopHandlers} />);
		expect(screen.queryByRole("button", { name: /make stretchy/i })).toBeNull();
	});
});

describe("AgendaEditor delete undo", () => {
	it("offers undo and restores EVERY field to the original position", async () => {
		const user = userEvent.setup();
		const onRemoveRow = vi.fn().mockResolvedValue(undefined);
		const onUpdateRow = vi.fn().mockResolvedValue(undefined);
		const onAddRow = vi.fn().mockResolvedValue({
			...(draft.rows[1] as AgendaDraft["rows"][number]),
			id: "restored",
		});
		// A row carrying something in every field, so a dropped one is visible.
		const rich: AgendaDraft = {
			...draft,
			rows: [
				draft.rows[0] as AgendaDraft["rows"][number],
				{
					...(draft.rows[1] as AgendaDraft["rows"][number]),
					detail: "Opens the room",
					markGreen: 5,
					markYellow: 6,
					markRed: 7,
				},
			],
		};
		// The Undo affordance IS a toast action, so the toaster has to be mounted
		// for this to test the real thing rather than a spy on `toast`. The app
		// mounts it in `__root.tsx`.
		render(
			<>
				<Toaster />
				<AgendaEditor
					draft={rich}
					{...noopHandlers}
					onRemoveRow={onRemoveRow}
					onAddRow={onAddRow}
					onUpdateRow={onUpdateRow}
				/>
			</>,
		);
		// Second row's delete — the first is the OPENING band.
		await user.click(screen.getAllByLabelText("Remove row")[1] as HTMLElement);
		await waitFor(() => expect(onRemoveRow).toHaveBeenCalledWith("r2"));

		await user.click(await screen.findByRole("button", { name: /undo/i }));

		// Re-inserted after its ORIGINAL predecessor, not appended: a row that
		// comes back at the bottom of the agenda is not the same row.
		await waitFor(() => expect(onAddRow).toHaveBeenCalledWith("r1", "role"));
		expect(onUpdateRow).toHaveBeenCalledWith("restored", {
			label: "Welcome",
			detail: "Opens the room",
			minutes: 5,
			roleKey: "toastmaster",
			repeatsRoleKey: null,
			flex: false,
			markGreen: 5,
			markYellow: 6,
			markRed: 7,
		});
	});

	it("restores a FIRST row to the front, not after something", async () => {
		const user = userEvent.setup();
		const onAddRow = vi.fn().mockResolvedValue({
			...(draft.rows[0] as AgendaDraft["rows"][number]),
			id: "restored",
		});
		render(
			<>
				<Toaster />
				<AgendaEditor draft={draft} {...noopHandlers} onAddRow={onAddRow} />
			</>,
		);
		await user.click(screen.getAllByLabelText("Remove row")[0] as HTMLElement);
		await user.click(await screen.findByRole("button", { name: /undo/i }));
		// null predecessor == the top of the agenda.
		await waitFor(() => expect(onAddRow).toHaveBeenCalledWith(null, "section"));
	});

	it("does NOT confirm before deleting", async () => {
		const user = userEvent.setup();
		const onRemoveRow = vi.fn().mockResolvedValue(undefined);
		render(
			<AgendaEditor
				draft={draft}
				{...noopHandlers}
				onRemoveRow={onRemoveRow}
			/>,
		);
		await user.click(screen.getAllByLabelText("Remove row")[1] as HTMLElement);
		// One click deletes. A modal on every delete taxes the deliberate case
		// hardest - trimming four rows becomes four modals - and a modal shown
		// every time is a modal nobody reads.
		expect(onRemoveRow).toHaveBeenCalledTimes(1);
	});

	it("offers no undo when the delete itself failed", async () => {
		const user = userEvent.setup();
		const onRemoveRow = vi.fn().mockRejectedValue(new Error("nope"));
		render(
			<>
				<Toaster />
				<AgendaEditor
					draft={draft}
					{...noopHandlers}
					onRemoveRow={onRemoveRow}
				/>
			</>,
		);
		await user.click(screen.getAllByLabelText("Remove row")[1] as HTMLElement);
		await waitFor(() => expect(onRemoveRow).toHaveBeenCalled());
		// Nothing was deleted, so there is nothing to undo — offering it would
		// re-add a row that never left.
		expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
	});
});

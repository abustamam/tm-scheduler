// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaDraft } from "#/server/meeting-agenda-edit";
import { AgendaEditor } from "./agenda-editor";

afterEach(cleanup);

const draft: AgendaDraft = {
	templateId: "tpl-1",
	templateName: "Standard meeting",
	editable: true,
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
	onAddRow: vi.fn().mockResolvedValue(undefined),
	onUpdateRow: vi.fn().mockResolvedValue(undefined),
	onRemoveRow: vi.fn().mockResolvedValue(undefined),
	onMoveRow: vi.fn().mockResolvedValue(undefined),
	onAddRole: vi.fn().mockResolvedValue(undefined),
	planRoleRemoval: vi.fn().mockResolvedValue([]),
	onRemoveRole: vi.fn().mockResolvedValue(undefined),
};

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
		rows: [
			{
				...(draft.rows[1] as AgendaDraft["rows"][number]),
				repeatsRoleKey: "toastmaster",
			},
		],
	};

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
		const minutes = screen.getAllByLabelText(
			"Row minutes",
		)[1] as HTMLInputElement;
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

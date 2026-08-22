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

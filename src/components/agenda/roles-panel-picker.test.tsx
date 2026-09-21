// @vitest-environment jsdom
//
// The agenda editor's Roles panel, since #802 gave it a picker over the club's
// own role bank.
//
// Scoped to that panel deliberately: `agenda-editor.test.tsx` covers the rows,
// the clock and the removal dialog, and its fixture carries an empty
// `attachableRoles` so nothing there changes. What this file holds is the half
// that was missing until now — an officer could only put a role on an agenda by
// TYPING a name they already knew, so a club's own Timer was reachable only by
// someone who had been told it existed, and the free-text form beside it is the
// one that FORKS a new role when the name does not match.
//
// The assertions are about which of the two paths a click takes, so they read
// the payload `onAddRole` was called with rather than anything the panel
// renders afterwards: `addAgendaRole` is find-and-attach-or-create keyed on the
// NAME (#801), so sending the bank role's own name IS the attach, and sending
// anything else is the fork.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaDraft } from "#/server/meeting-agenda-edit";
import { AgendaEditor } from "./agenda-editor";

afterEach(cleanup);

type AttachableRole = AgendaDraft["attachableRoles"][number];

const TIMER: AttachableRole = {
	key: "timer",
	name: "Timer",
	category: "functionary",
	defaultCount: 1,
	isSpeakerRole: false,
	standing: true,
};

const CONTESTANT: AttachableRole = {
	key: "contestant_prepared",
	name: "Contestant",
	category: "speaker",
	defaultCount: 4,
	isSpeakerRole: true,
	standing: false,
};

function draftWith(attachableRoles: AttachableRole[]): AgendaDraft {
	return {
		templateId: "tpl-1",
		templateName: "Standard meeting",
		editable: true,
		slots: [],
		scheduledAt: "2026-09-10T23:45:00.000Z",
		timeZone: "America/Chicago",
		lengthMinutes: 90,
		geIntroducesFunctionaries: false,
		rows: [],
		roles: [
			{
				key: "toastmaster_of_the_day",
				name: "Toastmaster",
				category: "leadership",
				defaultCount: 1,
				isSpeakerRole: false,
			},
		],
		attachableRoles,
	};
}

const handlers = {
	clubUuid: "00000000-0000-4000-8000-000000000000",
	onAddRow: vi.fn(),
	onUpdateRow: vi.fn().mockResolvedValue(undefined),
	onRemoveRow: vi.fn().mockResolvedValue(undefined),
	onMoveRow: vi.fn().mockResolvedValue(undefined),
	onRefresh: vi.fn().mockResolvedValue(undefined),
	planRoleRemoval: vi.fn().mockResolvedValue([]),
	onRemoveRole: vi.fn().mockResolvedValue(undefined),
};

function renderPanel(
	attachableRoles: AttachableRole[],
	over: Partial<AgendaDraft> = {},
) {
	const onAddRole = vi.fn().mockResolvedValue(undefined);
	render(
		<AgendaEditor
			draft={{ ...draftWith(attachableRoles), ...over }}
			{...handlers}
			onAddRole={onAddRole}
		/>,
	);
	return { onAddRole };
}

function picker() {
	return screen.getByLabelText("From your club's roles") as HTMLSelectElement;
}

describe("Roles panel club-bank picker", () => {
	it("lists the attached roles and the club's other roles as two separate things", () => {
		renderPanel([TIMER]);

		// What this agenda declares, each removable — unchanged.
		const attached = screen.getByRole("list", { name: "On this agenda" });
		expect(within(attached).getAllByRole("listitem")).toHaveLength(1);
		expect(
			within(attached).getByRole("button", { name: "Remove Toastmaster" }),
		).toBeTruthy();

		// And what the club has that this agenda does not.
		expect(
			within(picker()).getByRole("option", { name: /^Timer/ }),
		).toBeTruthy();
	});

	it("fires onAddRole with the PICKED role's own name, which is the attach path", async () => {
		const { onAddRole } = renderPanel([TIMER, CONTESTANT]);

		await userEvent.selectOptions(picker(), "contestant_prepared");
		await userEvent.click(
			screen.getByRole("button", { name: /add to agenda/i }),
		);

		// The bank row's four fields, not the create form's. Three of them the
		// attach arm will ignore (it reads them off the row it resolved); they
		// matter only if the club renamed the role since this page loaded, when
		// the name matches nothing and the create arm runs instead — and then a
		// four-place speaking Contestant is a far better guess than the form's
		// one-place Functionary default.
		expect(onAddRole).toHaveBeenCalledTimes(1);
		expect(onAddRole).toHaveBeenCalledWith({
			name: "Contestant",
			category: "speaker",
			defaultCount: 4,
			isSpeakerRole: true,
		});
	});

	// The mark AC 1 asks for. A role that arrived from a contest, or that
	// someone typed into another night's agenda, is `standing = false`: the club
	// owns it and it attaches like any other, but it is not part of the weekly
	// shape and should not read as if it were.
	it("groups the non-standing roles under their own heading", () => {
		renderPanel([TIMER, CONTESTANT]);

		const group = within(picker()).getByRole("group", {
			name: "Not on standard meetings",
		});
		expect(
			within(group).getByRole("option", { name: /^Contestant/ }),
		).toBeTruthy();
		// And the standing one is NOT in it.
		expect(within(group).queryByRole("option", { name: /^Timer/ })).toBeNull();
	});

	it("does not render the group when every offered role is standing", () => {
		renderPanel([TIMER]);

		expect(
			within(picker()).queryByRole("group", {
				name: "Not on standard meetings",
			}),
		).toBeNull();
	});

	it("keeps the Add button inert until a role is chosen", async () => {
		const { onAddRole } = renderPanel([TIMER]);

		const add = screen.getByRole("button", {
			name: /add to agenda/i,
		}) as HTMLButtonElement;
		expect(add.disabled).toBe(true);

		await userEvent.selectOptions(picker(), "timer");
		expect(add.disabled).toBe(false);
		await userEvent.click(add);
		expect(onAddRole).toHaveBeenCalledTimes(1);
	});

	// A club whose whole bank is already on this agenda has nothing to pick, and
	// an empty `<select>` reading "Choose a role…" says the picker is broken
	// rather than that there is nothing left.
	it("hides the picker entirely when the bank is exhausted", () => {
		renderPanel([]);

		expect(screen.queryByLabelText("From your club's roles")).toBeNull();
		// The create form stays — a club can always invent a role it lacks.
		expect(screen.getByLabelText("New role name")).toBeTruthy();
	});

	it("shows neither the picker nor the create form once the meeting is locked", () => {
		renderPanel([TIMER], { editable: false });

		expect(screen.queryByLabelText("From your club's roles")).toBeNull();
		expect(screen.queryByLabelText("New role name")).toBeNull();
	});

	// The two paths stay distinguishable. The free-text form is the one that
	// MINTS a role, and #801's fix means typing an existing name attaches
	// instead of forking — but the officer still has to know the name to type.
	// The picker is the other half, and a reader of this panel should be able to
	// tell which is which.
	it("still offers the create form, for a role the club does not have at all", async () => {
		const { onAddRole } = renderPanel([TIMER]);

		expect(screen.getByText("Create a new role")).toBeTruthy();
		await userEvent.type(screen.getByLabelText("New role name"), "Zoom Host");
		await userEvent.click(screen.getByRole("button", { name: /^add role$/i }));

		expect(onAddRole).toHaveBeenCalledWith({
			name: "Zoom Host",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});
	});
});

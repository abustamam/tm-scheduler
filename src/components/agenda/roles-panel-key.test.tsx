// @vitest-environment jsdom
//
// #836: the Roles panel's picker attaches by the bank row's KEY, and the typed
// box still goes by name. The name a picker entry carries was read at page
// load, so resolving a click by it attached whichever role held that name at
// CLICK time — a fork after a rename, and a different role entirely after a
// rename plus a reuse of the old name. `addAgendaRole` resolves the key
// (`add-agenda-role-by-key.integration.test.ts`); this pins that the panel
// actually sends it, and that the typed path does not.
import { cleanup, render, screen } from "@testing-library/react";
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

describe("Roles panel — which identity each path sends (#836)", () => {
	it("sends the picked bank row's key", async () => {
		const { onAddRole } = renderPanel([TIMER, CONTESTANT]);

		await userEvent.selectOptions(picker(), "contestant_prepared");
		await userEvent.click(
			screen.getByRole("button", { name: /add to agenda/i }),
		);

		expect(onAddRole).toHaveBeenCalledTimes(1);
		expect(onAddRole.mock.calls[0]?.[0]).toMatchObject({
			key: "contestant_prepared",
		});
	});

	it("sends NO key from the typed box, which resolves by name", async () => {
		const { onAddRole } = renderPanel([TIMER]);

		await userEvent.type(screen.getByLabelText("New role name"), "Timer");
		await userEvent.click(screen.getByRole("button", { name: /^add role$/i }));

		expect(onAddRole).toHaveBeenCalledTimes(1);
		const sent = onAddRole.mock.calls[0]?.[0];
		expect(sent).toMatchObject({ name: "Timer" });
		expect(sent).not.toHaveProperty("key");
	});
});

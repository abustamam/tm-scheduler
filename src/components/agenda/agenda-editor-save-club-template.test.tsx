// @vitest-environment jsdom
/**
 * The editor's "Save as club template" control (#909): where it appears, and
 * that the wired button sends the RESOLVED meeting uuid and lists only the
 * club's own templates for a replace.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaDraft } from "#/server/meeting-agenda-edit";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { AgendaEditor } from "./agenda-editor";

const listTemplatesForClub = vi.fn();
const saveAgendaAsClubTemplate = vi.fn();
vi.mock("#/server/meeting-templates", () => ({
	listTemplatesForClub: (arg: unknown) => listTemplatesForClub(arg),
	saveAgendaAsClubTemplate: (arg: unknown) => saveAgendaAsClubTemplate(arg),
}));

afterEach(() => {
	cleanup();
	listTemplatesForClub.mockReset();
	saveAgendaAsClubTemplate.mockReset();
});

const CLUB_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEETING_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const DRAFT: AgendaDraft = {
	meetingId: MEETING_UUID,
	cancelled: false,
	templateId: "tpl",
	templateName: "Standard",
	editable: true,
	rows: [],
	roles: [],
	slots: [],
	scheduledAt: "2026-09-30T02:00:00.000Z",
	timeZone: "America/Chicago",
	lengthMinutes: 90,
	geIntroducesFunctionaries: false,
	attachableRoles: [],
};

const noop = vi.fn(async () => ({}) as never);

async function renderEditor(draft: AgendaDraft) {
	await renderUnderMemoryRouter(
		<AgendaEditor
			draft={draft}
			clubUuid={CLUB_UUID}
			onAddRow={noop}
			onUpdateRow={noop}
			onRemoveRow={noop}
			onMoveRow={noop}
			onRefresh={noop}
			onAddRole={noop}
			planRoleRemoval={vi.fn(async () => [])}
			onRemoveRole={noop}
		/>,
	);
}

const SAVE = { name: "Save as club template" };

describe("AgendaEditor's save-as-club-template control", () => {
	it("appears on a completed meeting too, and not on a cancelled one or without a meeting id", async () => {
		await renderEditor({ ...DRAFT, editable: false });
		expect(screen.getByRole("button", SAVE)).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Add row: Section" }),
		).toBeNull();
		cleanup();

		// A cancelled meeting is read-only too, but the save would only refuse.
		await renderEditor({ ...DRAFT, editable: false, cancelled: true });
		expect(screen.queryByRole("button", SAVE)).toBeNull();
		cleanup();

		const { meetingId: _omit, ...withoutId } = DRAFT;
		await renderEditor(withoutId);
		expect(screen.queryByRole("button", SAVE)).toBeNull();
	});

	it("lists only the club's own templates and saves against the meeting uuid", async () => {
		listTemplatesForClub.mockResolvedValue([
			{ id: "g1", clubId: null, key: "speech_contest", name: "Speech Contest" },
			{
				id: "11111111-1111-4111-8111-111111111111",
				clubId: CLUB_UUID,
				key: "contest-night",
				name: "Contest night",
			},
		]);
		saveAgendaAsClubTemplate.mockResolvedValue({ templateId: "t" });
		const user = userEvent.setup();
		await renderEditor(DRAFT);

		await user.click(screen.getByRole("button", SAVE));
		await waitFor(() =>
			expect(listTemplatesForClub).toHaveBeenCalledWith({
				data: { clubId: CLUB_UUID },
			}),
		);
		await user.click(
			await screen.findByLabelText("Replace one of your club's templates"),
		);
		const select = screen.getByLabelText(
			"Template to replace",
		) as HTMLSelectElement;
		expect([...select.options].map((o) => o.textContent)).toEqual([
			"Choose a template",
			"Contest night",
		]);
		await user.selectOptions(select, "11111111-1111-4111-8111-111111111111");
		await user.click(screen.getByRole("button", { name: "Replace template" }));
		await waitFor(() =>
			expect(saveAgendaAsClubTemplate).toHaveBeenCalledWith({
				data: {
					meetingId: MEETING_UUID,
					mode: "replace",
					templateId: "11111111-1111-4111-8111-111111111111",
				},
			}),
		);
	});
});

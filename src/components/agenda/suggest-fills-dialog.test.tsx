// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRoleCounts } from "#/lib/agenda";
import { lockedViewer } from "#/lib/meeting-lifecycle";
import { meetingViewer } from "#/lib/meeting-viewer";
import { claimSlot } from "#/server/slots";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaProps,
} from "./meeting-agenda";
import {
	SuggestFillsDialog,
	type SuggestFillsDialogProps,
	type SuggestFillsSlot,
} from "./suggest-fills-dialog";

// The agenda imports every sheet's server-fn module and their `#/db` import;
// none of them run here. `claimSlot` is the one write this dialog makes.
vi.mock("#/db", () => ({ db: {} }));
vi.mock("#/server/slots", () => ({
	claimSlot: vi.fn(),
	reassignSlot: vi.fn(),
	releaseSlot: vi.fn(),
}));

const claim = vi.mocked(claimSlot);

function fillSlot(over: Partial<SuggestFillsSlot>): SuggestFillsSlot {
	return {
		id: "s1",
		roleDefinitionId: "timer",
		roleName: "Timer",
		slotIndex: 0,
		status: "open",
		assigneeId: null,
		isSpeakerRole: false,
		...over,
	};
}

const roster = [
	{ id: "a", name: "Ada" },
	{ id: "b", name: "Bea" },
	{ id: "c", name: "Cal" },
];

function renderDialog(over: Partial<SuggestFillsDialogProps> = {}) {
	const slots = over.slots ?? [
		fillSlot({ id: "t", roleDefinitionId: "timer", roleName: "Timer" }),
		fillSlot({ id: "g", roleDefinitionId: "gram", roleName: "Grammarian" }),
	];
	const props: SuggestFillsDialogProps = {
		open: true,
		onOpenChange: vi.fn(),
		slots,
		roster,
		roleByMemberId: {},
		unavailableIds: [],
		// Timer → a never held it; Grammarian → a is taken, then b (oldest).
		roleRecency: {
			gram: { b: "2025-01-01T00:00:00.000Z", c: "2026-01-01T00:00:00.000Z" },
		},
		roleCounts: buildRoleCounts(slots),
		actorMemberId: "me",
		onMutated: vi.fn(),
		...over,
	};
	render(<SuggestFillsDialog {...props} />);
	return props;
}

const select = (label: string) =>
	screen.getByLabelText(label) as HTMLSelectElement;
const confirmButton = () => screen.getByRole("button", { name: /^Confirm/ });

describe("SuggestFillsDialog (#58)", () => {
	beforeEach(() => {
		claim.mockReset();
		claim.mockResolvedValue({ ok: true } as never);
	});
	afterEach(() => cleanup());

	it("prefills each open slot with its suggestion and counts them", () => {
		renderDialog();
		expect(select("Timer").value).toBe("a");
		expect(select("Grammarian").value).toBe("b");
		expect(confirmButton().textContent).toContain("Confirm (2)");
	});

	it("confirms a swapped pick with the member the manager chose", async () => {
		const user = userEvent.setup();
		const props = renderDialog();
		await user.selectOptions(select("Timer"), "c");
		await user.click(confirmButton());
		expect(claim).toHaveBeenCalledTimes(2);
		expect(claim).toHaveBeenNthCalledWith(1, {
			data: {
				slotId: "t",
				memberId: "c",
				actorMemberId: "me",
				speakerDetails: undefined,
			},
		});
		expect(props.onMutated).toHaveBeenCalledTimes(1);
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("drops a removed row from the count and never writes it", async () => {
		const user = userEvent.setup();
		renderDialog();
		await user.click(screen.getByRole("button", { name: "Remove Timer" }));
		expect(screen.queryByLabelText("Timer")).toBeNull();
		expect(confirmButton().textContent).toContain("Confirm (1)");
		await user.click(confirmButton());
		expect(claim).toHaveBeenCalledTimes(1);
		expect(claim.mock.calls[0]?.[0]).toMatchObject({ data: { slotId: "g" } });
	});

	it("disables Confirm at zero, and skips a slot nobody was eligible for", async () => {
		const user = userEvent.setup();
		renderDialog({ unavailableIds: ["b", "c"] });
		// a takes Timer; the Grammarian has nobody left and defaults to Leave open.
		expect(select("Grammarian").value).toBe("");
		expect(screen.getByText("No one available")).toBeTruthy();
		expect(confirmButton().textContent).toContain("Confirm (1)");
		await user.selectOptions(select("Timer"), "");
		expect(confirmButton().textContent).toContain("Confirm (0)");
		expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
	});

	it("keeps going past a failing row, refreshes once, and shows only the failure", async () => {
		const user = userEvent.setup();
		const slots = [
			fillSlot({ id: "t", roleDefinitionId: "timer", roleName: "Timer" }),
			fillSlot({ id: "g", roleDefinitionId: "gram", roleName: "Grammarian" }),
			fillSlot({ id: "h", roleDefinitionId: "ah", roleName: "Ah-Counter" }),
		];
		claim
			.mockResolvedValueOnce({ ok: true } as never)
			.mockRejectedValueOnce(new Error("That role was just taken."))
			.mockResolvedValueOnce({ ok: true } as never);
		const props = renderDialog({ slots });
		await user.click(confirmButton());
		const slotIdOf = (call: unknown[]) =>
			(call[0] as { data: { slotId: string } }).data.slotId;
		expect(claim.mock.calls.map(slotIdOf)).toEqual(["t", "g", "h"]);
		expect(props.onMutated).toHaveBeenCalledTimes(1);
		expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
		expect(screen.getByRole("alert").textContent).toBe(
			"That role was just taken.",
		);
		expect(screen.getByLabelText("Grammarian")).toBeTruthy();
		expect(screen.queryByLabelText("Timer")).toBeNull();
		expect(screen.queryByLabelText("Ah-Counter")).toBeNull();
	});

	it("sends a speaker slot with the TBA speech title, like the assign sheet", async () => {
		const user = userEvent.setup();
		renderDialog({
			slots: [
				fillSlot({
					id: "sp",
					roleDefinitionId: "speaker",
					roleName: "Speaker",
					isSpeakerRole: true,
				}),
			],
		});
		await user.click(confirmButton());
		expect(claim).toHaveBeenCalledWith({
			data: {
				slotId: "sp",
				memberId: "a",
				actorMemberId: "me",
				speakerDetails: { speechTitle: "TBA" },
			},
		});
	});

	it("disables Confirm for a manager with no linked member", async () => {
		renderDialog({ actorMemberId: null });
		expect(
			screen.getByText("Your account isn't linked to a club member yet."),
		).toBeTruthy();
		expect((confirmButton() as HTMLButtonElement).disabled).toBe(true);
	});

	it("shows the role a manually picked member already holds", async () => {
		const user = userEvent.setup();
		renderDialog({
			slots: [
				fillSlot({
					id: "tm",
					roleDefinitionId: "tmod",
					roleName: "Toastmaster",
					status: "claimed",
					assigneeId: "c",
				}),
				fillSlot({ id: "t", roleDefinitionId: "timer", roleName: "Timer" }),
			],
			roleByMemberId: { c: "Toastmaster" },
		});
		// The suggestion never double-books c; a deliberate pick may.
		expect(screen.queryByLabelText("Toastmaster")).toBeNull();
		await user.selectOptions(select("Timer"), "c");
		const row = screen.getByTestId("suggest-row-t");
		expect(within(row).getByText(/Already Toastmaster/)).toBeTruthy();
	});
});

describe("MeetingAgenda: who sees Suggest fills (#58)", () => {
	afterEach(() => cleanup());

	function agendaSlot(over: Partial<AgendaSlot>): AgendaSlot {
		return {
			id: "s1",
			roleName: "Timer",
			roleDefinitionId: "rd1",
			category: "functionary",
			isSpeakerRole: false,
			slotIndex: 0,
			status: "open",
			assigneeId: null,
			assigneeName: null,
			speechTitle: null,
			pathwayPath: null,
			projectName: null,
			projectLevel: null,
			minMinutes: null,
			maxMinutes: null,
			description: null,
			evaluates: null,
			...over,
		} as unknown as AgendaSlot;
	}

	const noop = async () => {};
	const viewerFor = (canManage: boolean, isTmod: boolean, id: string | null) =>
		meetingViewer({
			currentMemberId: id,
			canManage,
			isTmod,
			isGrammarian: false,
			isEditableWindow: true,
		});

	function renderAgenda(
		viewer: ReturnType<typeof meetingViewer>,
		slots: AgendaSlot[],
	) {
		render(
			<MeetingAgenda
				slots={slots}
				viewer={viewer}
				actions={{
					claim: noop,
					release: noop,
					addSpeaker: noop,
					removeSpeaker: noop,
					confirm: noop,
					unconfirm: noop,
					onMutated: noop,
				}}
				roster={roster}
				roleRecency={{}}
				roleByMemberId={{}}
				unavailableMemberIds={[]}
				shareUrl="https://gavelup.app/club/test/meeting/m1"
				meetingDate="Jan 1, 2026"
				meeting={
					{
						id: "m1",
						clubId: "c1",
						scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
						status: "scheduled",
					} as unknown as MeetingAgendaProps["meeting"]
				}
				templateKey={null}
				timezone="UTC"
				selfMemberId="me"
				onMetaSaved={() => {}}
				contactedMemberIds={[]}
			/>,
		);
		return screen.queryByRole("button", { name: "Suggest fills" });
	}

	it("shows only for a manager, on an open meeting, with an open slot", async () => {
		const open = [agendaSlot({})];
		const filled = [
			agendaSlot({ status: "claimed", assigneeId: "a", assigneeName: "Ada" }),
		];
		const cases: [
			string,
			ReturnType<typeof meetingViewer>,
			AgendaSlot[],
			boolean,
		][] = [
			["manager", viewerFor(true, false, "me"), open, true],
			["TMOD who is not a manager", viewerFor(false, true, "me"), open, false],
			["plain member", viewerFor(false, false, "me"), open, false],
			["anonymous visitor", viewerFor(false, false, null), open, false],
			[
				"locked meeting",
				lockedViewer(viewerFor(true, false, "me")),
				open,
				false,
			],
			["zero open slots", viewerFor(true, false, "me"), filled, false],
		];
		for (const [name, viewer, slots, visible] of cases) {
			const button = renderAgenda(viewer, slots);
			expect({ name, visible: button !== null }).toEqual({ name, visible });
			cleanup();
		}

		// And the button actually opens the dialog with the suggestion prefilled.
		const user = userEvent.setup();
		const button = renderAgenda(viewerFor(true, false, "me"), open);
		await user.click(button as HTMLElement);
		const dialog = screen.getByRole("dialog");
		expect(
			(within(dialog).getByLabelText("Timer") as HTMLSelectElement).value,
		).toBe("a");
	});
});

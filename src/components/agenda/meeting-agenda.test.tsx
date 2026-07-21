// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lockedViewer } from "#/lib/meeting-lifecycle";
import { meetingViewer } from "#/lib/meeting-viewer";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
} from "./meeting-agenda";

// The component imports the AssignSlot/EditSpeech sheets, which pull in the
// server-fn modules and their `#/db` import. Those handlers never run in this
// render-only test, so stub the db client to avoid the eager "DATABASE_URL is
// not set" throw at import time. `vi.mock` is hoisted above the imports.
vi.mock("#/db", () => ({ db: {} }));

const noop = async () => {};
const actions: MeetingAgendaActions = {
	claim: noop,
	release: noop,
	addSpeaker: noop,
	removeSpeaker: noop,
	confirm: noop,
	unconfirm: noop,
	moveSpeaker: noop,
	removeRole: noop,
	takeover: noop,
	onMutated: noop,
};

function slot(over: Partial<AgendaSlot>): AgendaSlot {
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

function renderAgenda(
	viewer: ReturnType<typeof meetingViewer>,
	slots: AgendaSlot[],
	pairedRoleIds?: Set<string>,
) {
	return render(
		<MeetingAgenda
			slots={slots}
			viewer={viewer}
			actions={actions}
			roster={[]}
			roleRecency={{}}
			unavailableMemberIds={[]}
			pairedRoleIds={pairedRoleIds}
			shareUrl="https://gavelup.app/club/test/meeting/m1"
			meetingDate="Jan 1, 2026"
		/>,
	);
}

describe("MeetingAgenda capability gating", () => {
	afterEach(() => cleanup());

	it("shows admin controls (stats, confirm) for a manager", () => {
		const filled = slot({
			id: "s1",
			status: "claimed",
			assigneeId: "other",
			assigneeName: "Other Person",
			category: "leadership",
			roleName: "Toastmaster",
		});
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: true,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[filled],
		);
		expect(screen.getByText("Open roles:")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /Reassign/ })).toBeTruthy();
	});

	it("hides manager-only controls for a signed-in non-manager", () => {
		const filled = slot({
			status: "claimed",
			assigneeId: "other",
			assigneeName: "Other Person",
		});
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[filled],
		);
		expect(screen.queryByText("Open roles:")).toBeNull();
		expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
		expect(screen.queryByRole("button", { name: /Reassign/ })).toBeNull();
		// #302 parity: a signed-in non-manager gets the self-serve take-over, same
		// as a self-asserted public member — the unified viewer grants it on any
		// identity. Only the manager-only controls above stay hidden.
		expect(screen.getByText("take over")).toBeTruthy();
		expect(screen.getByText("Filled")).toBeTruthy();
	});

	it("shows takeover but no admin controls for a self-asserted member", () => {
		const filled = slot({
			status: "claimed",
			assigneeId: "other",
			assigneeName: "Other Person",
		});
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[filled],
		);
		expect(screen.getByText("take over")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
		expect(screen.queryByText("Open roles:")).toBeNull();
		// Not TMOD → no assign picker.
		expect(screen.queryByRole("button", { name: /Reassign/ })).toBeNull();
	});

	it("gives a visitor with no name a read-only agenda (claim disabled)", () => {
		renderAgenda(
			meetingViewer({
				currentMemberId: null,
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
		);
		const claim = screen.getByRole("button", { name: /^Claim / });
		expect((claim as HTMLButtonElement).disabled).toBe(true);
		expect(screen.queryByRole("button", { name: /Assign/ })).toBeNull();
	});

	it("is read-only under a locked viewer: no release on your own slot", () => {
		const mine = slot({
			status: "claimed",
			assigneeId: "me",
			assigneeName: "Me",
		});
		renderAgenda(
			lockedViewer(
				meetingViewer({
					currentMemberId: "me",
					canManage: false,
					isTmod: false,
					isGrammarian: false,
					isEditableWindow: true,
				}),
			),
			[mine],
		);
		// Own filled slot renders read-only — "Filled", no Release button.
		expect(screen.getByText("Filled")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
		expect(screen.queryByText("take over")).toBeNull();
	});

	it("is read-only under a locked viewer: open slots can't be claimed", () => {
		renderAgenda(
			lockedViewer(
				meetingViewer({
					currentMemberId: "me",
					canManage: false,
					isTmod: false,
					isGrammarian: false,
					isEditableWindow: true,
				}),
			),
			[slot({ status: "open" })],
		);
		const claim = screen.getByRole("button", { name: /^Claim / });
		expect((claim as HTMLButtonElement).disabled).toBe(true);
	});

	it("grants the TMOD assign + speaker management on the public surface", () => {
		const openSpeaker = slot({
			id: "sp1",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			status: "open",
		});
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: true,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[openSpeaker],
		);
		expect(screen.getByRole("button", { name: /Assign/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: "+ Add speaker" })).toBeTruthy();
	});
});

describe("MeetingAgenda remove-role control (#225)", () => {
	afterEach(() => cleanup());
	const manager = () =>
		meetingViewer({
			currentMemberId: "me",
			canManage: true,
			isTmod: false,
			isGrammarian: false,
			isEditableWindow: true,
		});

	it("keeps the enabled trash on an open, unassigned, non-paired slot", () => {
		renderAgenda(manager(), [slot({ status: "open" })]);
		const trash = screen.getByRole("button", {
			name: "Remove Timer",
		}) as HTMLButtonElement;
		expect(trash.disabled).toBe(false);
	});

	it("shows a disabled trash with 'Unassign first' on an assigned slot", () => {
		renderAgenda(manager(), [
			slot({ status: "claimed", assigneeId: "other", assigneeName: "Other" }),
		]);
		const trash = screen.getByRole("button", {
			name: "Remove Timer — unavailable: Unassign first",
		}) as HTMLButtonElement;
		expect(trash.disabled).toBe(true);
		// Pointer users get the same reason as a tooltip.
		expect(trash.title).toBe("Unassign first");
	});

	it("shows a disabled trash with the pairing reason on a paired evaluator slot", () => {
		renderAgenda(
			manager(),
			[
				slot({
					id: "ev1",
					roleName: "Evaluator",
					roleDefinitionId: "rdE",
					category: "evaluator",
					status: "open",
				}),
			],
			new Set(["rdE"]),
		);
		const trash = screen.getByRole("button", {
			name: "Remove Evaluator — unavailable: Remove the paired speaker role instead",
		}) as HTMLButtonElement;
		expect(trash.disabled).toBe(true);
		expect(trash.title).toBe("Remove the paired speaker role instead");
	});

	it("omits the trash on speaker cards — '− Remove speaker' is the affordance", () => {
		renderAgenda(
			manager(),
			[
				slot({
					id: "sp1",
					roleName: "Speaker",
					roleDefinitionId: "rdS",
					category: "speaker",
					isSpeakerRole: true,
					status: "open",
				}),
			],
			new Set(["rdS"]),
		);
		expect(
			screen.queryByRole("button", { name: /^Remove Speaker/ }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "− Remove speaker" }),
		).toBeTruthy();
	});

	it("renders no trash at all for a non-manager", () => {
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
		);
		expect(screen.queryByRole("button", { name: /^Remove Timer/ })).toBeNull();
	});
});

describe("tap-to-nudge confirm gate (#37)", () => {
	afterEach(() => cleanup());
	const manager = () =>
		meetingViewer({
			currentMemberId: "me",
			canManage: true,
			isTmod: false,
			isGrammarian: false,
			isEditableWindow: true,
		});
	const member = () =>
		meetingViewer({
			currentMemberId: "me",
			canManage: false,
			isTmod: false,
			isGrammarian: false,
			isEditableWindow: true,
		});
	const filled = () =>
		slot({
			status: "claimed",
			assigneeId: "other",
			assigneeName: "Other Person",
		});

	it("renders the confirm nudge for a manager on a filled slot", () => {
		renderAgenda(manager(), [filled()]);
		// The factory leaves holderPhone/holderEmail unset, so NudgeButtons
		// renders its no-contact fallback — proof the component rendered at all
		// under a manager viewer on a filled slot.
		expect(screen.getByText(/no contact on file/i)).toBeTruthy();
	});

	it("does not render the confirm nudge for a manager on an open slot", () => {
		renderAgenda(manager(), [slot({ status: "open" })]);
		expect(screen.queryByText(/no contact on file/i)).toBeNull();
		expect(screen.queryByRole("link", { name: /whatsapp/i })).toBeNull();
		expect(screen.queryByRole("link", { name: /email/i })).toBeNull();
	});

	it("does not render the confirm nudge for a non-manager on a filled slot", () => {
		renderAgenda(member(), [filled()]);
		expect(screen.queryByText(/no contact on file/i)).toBeNull();
		expect(screen.queryByRole("link", { name: /whatsapp/i })).toBeNull();
		expect(screen.queryByRole("link", { name: /email/i })).toBeNull();
	});

	it("renders a real Email nudge link when the holder has contact info", () => {
		renderAgenda(manager(), [
			slot({
				status: "claimed",
				assigneeId: "other",
				assigneeName: "Other Person",
				holderEmail: "other@example.com",
			}),
		]);
		expect(screen.queryByText(/no contact on file/i)).toBeNull();
		const emailLink = screen.getByRole("link", {
			name: /email/i,
		}) as HTMLAnchorElement;
		expect(emailLink.href.startsWith("mailto:other@example.com")).toBe(true);
	});

	it("renders the recruit picker for a manager on an open slot", () => {
		renderAgenda(manager(), [slot({ status: "open" })]);
		expect(screen.getByRole("button", { name: /nudge someone/i })).toBeTruthy();
	});

	it("does not render the recruit picker on a filled slot", () => {
		renderAgenda(manager(), [filled()]);
		expect(screen.queryByRole("button", { name: /nudge someone/i })).toBeNull();
	});

	it("does not render the recruit picker for a non-manager", () => {
		renderAgenda(member(), [slot({ status: "open" })]);
		expect(screen.queryByRole("button", { name: /nudge someone/i })).toBeNull();
	});
});

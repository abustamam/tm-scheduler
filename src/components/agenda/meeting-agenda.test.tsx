// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lockedViewer } from "#/lib/meeting-lifecycle";
import { selfAssertedViewer, sessionViewer } from "#/lib/meeting-viewer";
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
	viewer: ReturnType<typeof sessionViewer>,
	slots: AgendaSlot[],
) {
	return render(
		<MeetingAgenda
			slots={slots}
			viewer={viewer}
			actions={actions}
			roster={[]}
			roleRecency={{}}
			unavailableMemberIds={[]}
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
		renderAgenda(sessionViewer({ currentMemberId: "me", canManage: true }), [
			filled,
		]);
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
		renderAgenda(sessionViewer({ currentMemberId: "me", canManage: false }), [
			filled,
		]);
		expect(screen.queryByText("Open roles:")).toBeNull();
		expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
		expect(screen.queryByText("take over")).toBeNull();
		expect(screen.getByText("Filled")).toBeTruthy();
	});

	it("shows takeover but no admin controls for a self-asserted member", () => {
		const filled = slot({
			status: "claimed",
			assigneeId: "other",
			assigneeName: "Other Person",
		});
		renderAgenda(selfAssertedViewer({ memberId: "me", isTmod: false }), [
			filled,
		]);
		expect(screen.getByText("take over")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
		expect(screen.queryByText("Open roles:")).toBeNull();
		// Not TMOD → no assign picker.
		expect(screen.queryByRole("button", { name: /Reassign/ })).toBeNull();
	});

	it("gives a visitor with no name a read-only agenda (claim disabled)", () => {
		renderAgenda(selfAssertedViewer({ memberId: null, isTmod: false }), [
			slot({ status: "open" }),
		]);
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
			lockedViewer(selfAssertedViewer({ memberId: "me", isTmod: false })),
			[mine],
		);
		// Own filled slot renders read-only — "Filled", no Release button.
		expect(screen.getByText("Filled")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
		expect(screen.queryByText("take over")).toBeNull();
	});

	it("is read-only under a locked viewer: open slots can't be claimed", () => {
		renderAgenda(
			lockedViewer(selfAssertedViewer({ memberId: "me", isTmod: false })),
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
		renderAgenda(selfAssertedViewer({ memberId: "me", isTmod: true }), [
			openSpeaker,
		]);
		expect(screen.getByRole("button", { name: /Assign/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: "+ Add speaker" })).toBeTruthy();
	});
});

// @vitest-environment jsdom

// Undo on the meeting agenda's release toast (#1427). Season-grid's rule: Undo
// only where it re-claims the viewer's OWN role; take-over and an officer's
// release of someone else's role stay one-way.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingViewer } from "#/lib/meeting-viewer";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
	type MeetingAgendaProps,
} from "./meeting-agenda";

vi.mock("#/db", () => ({ db: {} }));
vi.mock("@tanstack/react-router", async (importOriginal) =>
	(await import("#/test/router-link-stub")).routerLinkMock(
		await importOriginal<typeof import("@tanstack/react-router")>(),
	),
);
const { toastSuccess, toastError } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: toastSuccess, error: toastError }),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function slot(): AgendaSlot {
	return {
		id: "s1",
		roleName: "Timer",
		roleDefinitionId: "rd1",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		status: "claimed",
		assigneeId: "m-holder",
		assigneeName: "Holder",
		assigneeIsGuest: false,
		speechTitle: null,
		pathwayPath: null,
		projectName: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		description: null,
		evaluates: null,
	} as unknown as AgendaSlot;
}

function mount(opts: {
	viewerId: string;
	canManage: boolean;
	claim?: MeetingAgendaActions["claim"];
}) {
	const claim = vi.fn(opts.claim ?? (async () => {}));
	const release = vi.fn(async () => {});
	const actions: MeetingAgendaActions = {
		claim,
		release,
		addSpeaker: async () => {},
		removeSpeaker: async () => {},
		confirm: async () => {},
		unconfirm: async () => {},
		moveSpeaker: async () => {},
		removeRole: async () => {},
		takeover: async () => {},
		onMutated: async () => {},
	};
	render(
		<MeetingAgenda
			slots={[slot()]}
			viewer={meetingViewer({
				currentMemberId: opts.viewerId,
				canManage: opts.canManage,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
				isSignedIn: true,
			})}
			actions={actions}
			roster={[]}
			roleRecency={{}}
			roleByMemberId={{ "m-holder": "Timer" }}
			unavailableMemberIds={[]}
			shareUrl="https://gavelup.app/club/test/meeting/m1"
			meetingDate="Jan 1, 2026"
			meetingUrlKey="2026-10-06"
			meeting={
				{
					id: "m1",
					scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
					status: "scheduled",
					lengthMinutes: 90,
					theme: null,
					location: null,
					wordOfTheDay: null,
					wodDefinition: null,
					wodExample: null,
					notes: null,
				} as unknown as MeetingAgendaProps["meeting"]
			}
			meetingOver={false}
			contactedMemberIds={[]}
		/>,
	);
	return { claim, release };
}

type ToastOpts = { action?: { label: string; onClick: () => void } };
function releaseToastOpts(): ToastOpts {
	return toastSuccess.mock.calls[0][1] as ToastOpts;
}

describe("MeetingAgenda: Undo on release (#1427)", () => {
	it("offers Undo on your own release, and Undo re-claims that same slot", async () => {
		// protects=releasing your own role toasts an Undo whose tap calls
		//   actions.claim with the SAME slot (asserted on the call args)
		// fails_when=the toast has no action, or Undo claims a different slot or
		//   not at all
		// no_claim=that the server re-assigns it to you (claim is a stub here)
		const { claim, release } = mount({
			viewerId: "m-holder",
			canManage: false,
		});
		await userEvent.click(screen.getByRole("button", { name: "Release" }));
		await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
		const action = releaseToastOpts().action;
		expect(action?.label).toBe("Undo");
		action?.onClick();
		await waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
		expect(claim.mock.calls[0][0]).toMatchObject({ id: "s1" });
	});

	it("offers no Undo when an officer releases another member's role", async () => {
		// protects=a manager's release of someone else's role has no action, so a
		//   re-claim can never make the officer the holder
		// fails_when=the action is attached regardless of whose role it was
		// no_claim=the toast wording
		const { release } = mount({ viewerId: "m-officer", canManage: true });
		await userEvent.click(screen.getByRole("button", { name: "Release" }));
		await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(toastSuccess).toHaveBeenCalledWith("Role released."),
		);
		expect(toastSuccess.mock.calls[0]).toHaveLength(1);
	});

	it("shows the write-error toast, not a success, when the re-claim fails", async () => {
		// protects=a refused re-claim (someone took the role) reports an error and
		//   does not say "Role back."
		// fails_when=the Undo swallows the rejection or toasts success anyway
		// no_claim=the wording of the error, which showWriteError owns
		const { claim } = mount({
			viewerId: "m-holder",
			canManage: false,
			claim: async () => {
				throw new Error("That role was just taken.");
			},
		});
		await userEvent.click(screen.getByRole("button", { name: "Release" }));
		await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
		releaseToastOpts().action?.onClick();
		await waitFor(() => expect(claim).toHaveBeenCalled());
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(toastSuccess).not.toHaveBeenCalledWith("Role back.");
	});
});

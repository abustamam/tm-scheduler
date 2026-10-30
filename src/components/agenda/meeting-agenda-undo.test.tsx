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

function slot(over: Partial<AgendaSlot> = {}): AgendaSlot {
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
		...over,
	} as unknown as AgendaSlot;
}

function mount(opts: {
	viewerId: string;
	canManage: boolean;
	claim?: MeetingAgendaActions["claim"];
	slot?: Partial<AgendaSlot>;
	/** Hours from now to the meeting; default 30 days. */
	hoursOut?: number;
	onOwnLateRelease?: MeetingAgendaProps["onOwnLateRelease"];
}) {
	const claim = vi.fn(opts.claim ?? (async () => {}));
	const release = vi.fn(async () => {});
	const onMutated = vi.fn(async () => {});
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
		onMutated,
	};
	render(
		<MeetingAgenda
			slots={[slot(opts.slot)]}
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
					scheduledAt: new Date(
						Date.now() + (opts.hoursOut ?? 30 * 24) * 3_600_000,
					).toISOString(),
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
			onOwnLateRelease={opts.onOwnLateRelease}
		/>,
	);
	return { claim, release, onMutated };
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

	it("offers no Undo on a released speaker role with a speech attached", async () => {
		// protects=release unlinks the speech and a re-claim returns the slot as
		//   TBA, so "Role back." is never offered for it
		// fails_when=the speech gate is dropped
		// no_claim=a speaker role with no speech (Undo is offered there)
		const { release } = mount({
			viewerId: "m-holder",
			canManage: false,
			slot: { isSpeakerRole: true, speechTitle: "My Ice Breaker" },
		});
		await userEvent.click(screen.getByRole("button", { name: "Release" }));
		await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
		expect(releaseToastOpts().action).toBeUndefined();
	});

	it("a successful Undo toasts and refreshes the agenda", async () => {
		// protects=success path: "Role back." and the onMutated refresh
		// fails_when=no refresh after the re-claim
		// no_claim=server acceptance (stubbed)
		const { release, onMutated } = mount({
			viewerId: "m-holder",
			canManage: false,
		});
		await userEvent.click(screen.getByRole("button", { name: "Release" }));
		await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
		const action = releaseToastOpts().action;
		onMutated.mockClear();
		action?.onClick();
		await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith("Role back.");
	});
});

describe("MeetingAgenda: own release inside 48h (#1439)", () => {
	it("hands your OWN release inside 48h to onOwnLateRelease and releases nothing", async () => {
		// protects=the cover sheet gets the slot and nothing is released until it
		//   asks for it (AC 1)
		// fails_when=the release goes through anyway, or the callback is skipped
		const onOwnLateRelease = vi.fn();
		const { release } = mount({
			viewerId: "m-holder",
			canManage: false,
			hoursOut: 24,
			onOwnLateRelease,
		});
		await userEvent.click(screen.getByRole("button", { name: "Release" }));
		expect(onOwnLateRelease).toHaveBeenCalledTimes(1);
		expect(onOwnLateRelease.mock.calls[0][0]).toMatchObject({ id: "s1" });
		expect(release).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("releases at once when the meeting is more than 48h out", async () => {
		// protects=AC 2: a release further out behaves exactly as before
		// fails_when=the gate ignores the date and opens the sheet always
		const onOwnLateRelease = vi.fn();
		const { release } = mount({
			viewerId: "m-holder",
			canManage: false,
			hoursOut: 72,
			onOwnLateRelease,
		});
		await userEvent.click(screen.getByRole("button", { name: "Release" }));
		await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
		expect(onOwnLateRelease).not.toHaveBeenCalled();
	});

	it("releases at once when an officer releases someone else's row inside 48h", async () => {
		// protects=AC 2: the officer's release of another's row never opens the
		//   sheet, which is for the holder's own handoff
		// fails_when=the gate stops checking that the row is the viewer's own
		const onOwnLateRelease = vi.fn();
		const { release } = mount({
			viewerId: "m-officer",
			canManage: true,
			hoursOut: 24,
			onOwnLateRelease,
		});
		await userEvent.click(screen.getByRole("button", { name: "Release" }));
		await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
		expect(onOwnLateRelease).not.toHaveBeenCalled();
	});

	it("releases at once when the route supplies no sheet", async () => {
		// protects=a surface that does not wire the sheet keeps today's release
		// fails_when=doRelease assumes the callback exists
		const { release } = mount({
			viewerId: "m-holder",
			canManage: false,
			hoursOut: 24,
		});
		await userEvent.click(screen.getByRole("button", { name: "Release" }));
		await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
	});
});

// @vitest-environment jsdom

/**
 * The meeting page's role card shows a guest's kind caption (#1059) in the
 * "Guest" badge's place — and a Visitor keeps the badge.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingViewer } from "#/lib/meeting-viewer";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
	type MeetingAgendaProps,
} from "./meeting-agenda";

// Same stub as `meeting-agenda.test.tsx`: the sheets this component imports
// pull in `#/db`, which throws at import time without a DATABASE_URL.
vi.mock("#/db", () => ({ db: {} }));

afterEach(cleanup);

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

function guestSlot(caption: string | null): AgendaSlot {
	return {
		id: "s1",
		roleName: "Speaker",
		roleDefinitionId: "rd1",
		category: "speaker",
		isSpeakerRole: true,
		slotIndex: 0,
		status: "claimed",
		assigneeId: null,
		assigneeGuestId: "g1",
		assigneeName: "Ben Carter",
		assigneeIsGuest: true,
		assigneeGuestCaption: caption,
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

function renderCard(slot: AgendaSlot) {
	return render(
		<MeetingAgenda
			slots={[slot]}
			viewer={meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			})}
			actions={actions}
			roster={[]}
			roleRecency={{}}
			roleByMemberId={{}}
			unavailableMemberIds={[]}
			shareUrl="https://gavelup.app/club/test/meeting/m1"
			meetingDate="Jan 1, 2026"
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
			templateKey={null}
			timezone="UTC"
			meetingOver={false}
			selfMemberId="me"
			onMetaSaved={() => {}}
			contactedMemberIds={[]}
		/>,
	);
}

describe("a guest holder's caption on the role card", () => {
	it("shows a guest speaker's caption in the badge's place", () => {
		renderCard(guestSlot("Guest speaker, Downtown Toastmasters"));
		expect(screen.getByText("Ben Carter")).toBeTruthy();
		expect(
			screen.getByText("Guest speaker, Downtown Toastmasters"),
		).toBeTruthy();
		expect(screen.queryByText("Guest")).toBeNull();
	});

	it("keeps the Guest badge for a Visitor", () => {
		renderCard(guestSlot(null));
		expect(screen.getByText("Guest")).toBeTruthy();
	});
});

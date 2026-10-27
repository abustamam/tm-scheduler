// @vitest-environment jsdom
//
// The agenda's slot anchors (#1376): the meeting page's "Your jobs" card links
// to `#slot-<slotId>` for a speaker's speech details.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingViewer } from "#/lib/meeting-viewer";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
	type MeetingAgendaProps,
} from "./meeting-agenda";

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

const slots = ["slot-aaa", "slot-bbb"].map(
	(id, i) =>
		({
			id,
			roleName: "Speaker",
			roleDefinitionId: "rd1",
			category: "speaker",
			isSpeakerRole: true,
			slotIndex: i,
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
		}) as unknown as AgendaSlot,
);

afterEach(cleanup);

describe("MeetingAgenda slot anchors (#1376)", () => {
	// protects=the "Your jobs" card's #slot-<id> link has a target; fails_when=the
	// slot <li> loses its id or it is not slot-<slotId>; no_claim=the scroll
	// offset (a class, asserted by mutation) or the card's href.
	it("gives each slot card id=slot-<slotId> and a header-clearing scroll margin", () => {
		const { container } = render(
			<MeetingAgenda
				slots={slots}
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
				meetingOver={false}
				contactedMemberIds={[]}
			/>,
		);
		for (const s of slots) {
			const el = container.querySelector(`#slot-${s.id}`);
			expect(el, `slot-${s.id}`).not.toBeNull();
			expect(el?.tagName).toBe("LI");
			// The sticky header is ~112px: the route's other anchors use the same.
			expect(el?.className).toContain("scroll-mt-28");
		}
	});
});

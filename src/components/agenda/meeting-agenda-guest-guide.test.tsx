// @vitest-environment jsdom
//
// The agenda → NudgeButtons wiring for the `confirm` draft's link (#933):
// a GUEST holder's draft links the role's card on the public roles guide
// (`roles-guide#<key>`), a MEMBER holder's links their own `/me` page. The
// builder is unit-tested in `nudge.test.ts`; this is the call site, which a
// component tested only through its props cannot see.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingViewer } from "#/lib/meeting-viewer";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
	type MeetingAgendaProps,
} from "./meeting-agenda";

// The sheets the agenda imports reach `#/db`; nothing here runs a handler.
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

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s1",
		roleName: "Toastmaster",
		roleKey: "toastmaster_of_the_day",
		roleDefinitionId: "rd1",
		category: "leadership",
		isSpeakerRole: false,
		slotIndex: 0,
		status: "claimed",
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

const meeting = {
	id: "m1",
	scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
	status: "scheduled",
	lengthMinutes: 90,
	theme: "Beginnings",
	location: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	notes: null,
} as unknown as MeetingAgendaProps["meeting"];

function renderAgenda(slots: AgendaSlot[]) {
	render(
		<MeetingAgenda
			slots={slots}
			viewer={meetingViewer({
				currentMemberId: "me",
				canManage: true,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			})}
			actions={actions}
			roster={[]}
			roleRecency={{}}
			roleByMemberId={{}}
			unavailableMemberIds={[]}
			shareUrl="https://gavelup.app/club/downtown/meeting/2026-10-13"
			meetingDate="Tue, Oct 13"
			meeting={meeting}
			templateKey={null}
			timezone="UTC"
			meetingOver={false}
			selfMemberId="me"
			onMetaSaved={() => {}}
			contactedMemberIds={[]}
			personalNudgeBase={{
				origin: "https://gavelup.app",
				clubId: "downtown",
				meetingKey: "2026-10-13",
			}}
		/>,
	);
}

/** The drafted message, out of the Email link's `body=`. */
function draftBody(): string {
	const link = screen.getByRole("link", {
		name: /email/i,
	}) as HTMLAnchorElement;
	const body = new URL(link.href).searchParams.get("body");
	if (!body) throw new Error("no draft body");
	return body;
}

describe("the confirm draft's link, by holder (#933)", () => {
	it("a GUEST holder's draft links roles-guide#<their role>", () => {
		renderAgenda([
			slot({
				assigneeId: null,
				assigneeGuestId: "g1",
				assigneeIsGuest: true,
				assigneeName: "Gina Guest",
				holderEmail: "gina@example.com",
			} as Partial<AgendaSlot>),
		]);
		const body = draftBody();
		expect(body).toContain(
			"https://gavelup.app/club/downtown/roles-guide#toastmaster-of-the-day",
		);
		expect(body).not.toContain("/me?as=");
	});

	it("a MEMBER holder's draft links their own /me page", () => {
		renderAgenda([
			slot({
				assigneeId: "m-42",
				assigneeName: "Marcus Lee",
				holderEmail: "marcus@example.com",
			}),
		]);
		const body = draftBody();
		expect(body).toContain(
			"https://gavelup.app/club/downtown/meeting/2026-10-13/me?as=m-42",
		);
		expect(body).not.toContain("roles-guide");
	});
});

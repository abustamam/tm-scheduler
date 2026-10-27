// @vitest-environment jsdom

// The viewer's OWN "can't make it" flag, and which sentence it says (#1344).
//
// Two things put a held role on `unavailableMemberIds`: the member said "not
// coming" on the plan, or the ROLL marked them Absent. The first is theirs, so
// "You said you can't make it." is true. The second they said nothing about, so
// the same sentence is wrong, and the own card says "You're marked absent."
// instead. The route computes `markedAbsentMemberIds` (unavailable minus the
// PUBLIC `not_coming` answers) and hands it down; this file pins what the
// component does with it. The route half is `meeting-marked-absent-wiring.guard
// .test.ts`: a component test injects the prop itself, so it cannot see whether
// the route ever supplies the right one.
//
// A separate file from `meeting-agenda.test.tsx` on purpose: that one carries
// the #764 flag's third-person and gating cases and stays as it was.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingViewer } from "#/lib/meeting-viewer";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
	type MeetingAgendaProps,
} from "./meeting-agenda";

// The component pulls in the server-fn modules and their `#/db` import. None of
// those handlers run in a render-only test; stub the client so the import does
// not throw on a missing DATABASE_URL. Hoisted above the imports.
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

/** One claimed Timer held by a member, so the role label is unnumbered. */
function heldTimer(): AgendaSlot {
	return {
		id: "s1",
		roleName: "Timer",
		roleDefinitionId: "rd1",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		status: "claimed",
		assigneeId: "m-held",
		assigneeName: "Held Holder",
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

function viewerWho(currentMemberId: string) {
	return meetingViewer({
		currentMemberId,
		canManage: false,
		isTmod: false,
		isGrammarian: false,
		isEditableWindow: true,
		isSignedIn: true,
	});
}

function renderAgenda(
	currentMemberId: string,
	extra: Partial<MeetingAgendaProps>,
) {
	return render(
		<MeetingAgenda
			slots={[heldTimer()]}
			viewer={viewerWho(currentMemberId)}
			actions={actions}
			roster={[]}
			roleRecency={{}}
			roleByMemberId={{ "m-held": "Timer" }}
			unavailableMemberIds={[]}
			shareUrl="https://gavelup.app/club/test/meeting/m1"
			meetingDate="Jan 1, 2026"
			meeting={
				{
					id: "m1",
					// 30 days out, so the meeting is not over and the flag renders.
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
			selfMemberId={currentMemberId}
			onMetaSaved={() => {}}
			contactedMemberIds={[]}
			{...extra}
		/>,
	);
}

describe("MeetingAgenda: the own-card flag's wording (#1344)", () => {
	afterEach(() => cleanup());

	it("says 'marked absent' when the roll, not the member, made them unavailable", () => {
		renderAgenda("m-held", {
			unavailableMemberIds: ["m-held"],
			markedAbsentMemberIds: ["m-held"],
		});
		// Anchor: this IS the viewer's own card, so the second-person arm ran.
		expect(screen.getByText("(you)")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe(
			"You're marked absent. Timer needs a new holder.",
		);
	});

	it("keeps 'you said' when the member said it themselves", () => {
		// Unavailable and NOT in the marked-absent list: the plan answer is theirs.
		renderAgenda("m-held", {
			unavailableMemberIds: ["m-held"],
			markedAbsentMemberIds: ["someone-else"],
		});
		expect(screen.getByText("(you)")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe(
			"You said you can't make it. Timer needs a new holder.",
		);
	});

	it("defaults to 'you said' when the caller does not supply the list", () => {
		// The prop is optional so every other caller of <MeetingAgenda> keeps the
		// first-person copy it had; an omitted list must not read as "marked absent".
		renderAgenda("m-held", { unavailableMemberIds: ["m-held"] });
		expect(screen.getByText("(you)")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe(
			"You said you can't make it. Timer needs a new holder.",
		);
	});

	it("leaves the third-person copy alone, whatever the marked-absent list holds", () => {
		// The viewer is NOT the holder. Another person's card never says why they
		// are unavailable, so the roll's reason does not reach it.
		renderAgenda("me", {
			unavailableMemberIds: ["m-held"],
			markedAbsentMemberIds: ["m-held"],
		});
		// Anchor: the holder's card rendered and it is not the viewer's.
		expect(screen.getByText("Held Holder")).toBeTruthy();
		expect(screen.queryByText("(you)")).toBeNull();
		expect(screen.getByRole("status").textContent).toBe(
			"Held Holder can't make it. Timer needs a new holder.",
		);
	});

	it("does not flag a holder only because they are on the marked-absent list", () => {
		// The flag is still gated on `unavailableMemberIds`; the new list only
		// chooses the sentence. A stale id there must not raise a flag by itself.
		renderAgenda("m-held", {
			unavailableMemberIds: [],
			markedAbsentMemberIds: ["m-held"],
		});
		expect(screen.getByText("(you)")).toBeTruthy();
		expect(screen.queryByRole("status")).toBeNull();
	});
});

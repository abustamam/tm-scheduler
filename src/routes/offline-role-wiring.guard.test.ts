/**
 * The meeting route's half of offline role edits (#1638).
 *
 * The route cannot be mounted in a test (see `meeting-room-wiring.guard.test.ts`),
 * so the hook, the queue and the sheet are tested where they live and this file
 * pins the wiring none of them can see.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";
const AGENDA = "src/components/agenda/meeting-agenda.tsx";
const flat = (t: string) => t.replace(/\s+/g, " ");
const route = flat(readSource(ROUTE));
const agenda = flat(readSource(AGENDA));

describe("the meeting route wires offline role edits (#1638)", () => {
	// protects=a queued role change shows on every consumer of `slots`, and the
	//   queue knows whose op it is;
	// fails_when=the projection is dropped or fed the loader's slots only, or the
	//   session member stops being passed to the queue;
	// no_claim=what the projection does (project-slots.test.ts)
	it("projects the queue over the loader's slots and names the session member", () => {
		expect(route).toContain(
			"projectSlots(loaderSlots, offlineMinutes.roleOps)",
		);
		expect(route).toContain("sessionMemberId:");
	});

	// protects=the claim / release / takeover hook shares the route's one queue
	//   and has the viewer's name for the optimistic row;
	// fails_when=either prop is dropped, so the actions call the server directly
	//   or queue a row with no name;
	// no_claim=the hook's branches (use-meeting-cover-offline.test.tsx)
	it("hands useMeetingCover the queue and the viewer's name", () => {
		expect(route).toMatch(
			/useMeetingCover\(\{ offlineMinutes, myName: member\?\.name \?\? null,/,
		);
	});

	// protects=the agenda and its assign sheet use the SAME queue;
	// fails_when=either prop is dropped: the sheet then writes directly offline;
	// no_claim=that the sheet queues (assign-slot-sheet-offline.test.tsx)
	it("gives <MeetingAgenda> the queue, and the agenda gives it to AssignSlotSheet", () => {
		expect(route).toContain("<MeetingAgenda offlineMinutes={offlineMinutes}");
		expect(agenda).toMatch(
			/<AssignSlotSheet[^>]*offlineMinutes=\{offlineMinutes\}/,
		);
	});
});

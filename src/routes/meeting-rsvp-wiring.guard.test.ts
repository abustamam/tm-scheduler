// Wiring guard for the meeting route's RSVP props (#1442).
//
// The route cannot mount in vitest, and the components it feeds are tested
// through their props, which cannot see a WRONG prop: pointing `rsvpUrl` at the
// agenda URL, or loosening the "N coming" gate, passes every component test.
// So the two spots are pinned here against the comment-blind source.
//
// Covers: `rsvpUrl` fed from `rsvpPageUrl(nudgeShareUrl)` and passed to the
// panel as that value; the "N coming" line's gate (not the panel, upcoming,
// not cancelled, count above zero).
// Does NOT cover: that the rendered line shows the right number (the
// `publicComingCount` tests) or the draft's wording.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SRC = readSource(
	resolve(__dirname, "club.$clubId.meeting.$meetingId.tsx"),
);
const squash = (s: string) => s.replace(/\s+/g, " ");

describe("meeting route RSVP wiring (#1442)", () => {
	it("builds the nudge's RSVP URL with rsvpPageUrl over the meeting URL", () => {
		// protects=a still-to-answer draft links the RSVP page
		// fails_when=the const points at the agenda URL or hand-spells the path
		expect(squash(SRC)).toContain(
			"const nudgeRsvpUrl = rsvpPageUrl(nudgeShareUrl);",
		);
	});

	it("passes that value to the panel as rsvpUrl", () => {
		// fails_when=the panel is handed the agenda URL (or nothing)
		expect(squash(SRC)).toContain("rsvpUrl={nudgeRsvpUrl}");
		expect(squash(SRC)).toContain("rsvpWeekday={nudgeWeekday}");
	});

	it("shows the N coming line only off the panel, upcoming, not cancelled, count > 0", () => {
		// protects=everyone else sees a count and nothing behind it, never on a
		//   past or cancelled meeting, never "0 coming"
		// fails_when=any one of the four conditions is dropped or loosened
		expect(squash(SRC)).toContain(
			'{!showPanel && phase === "upcoming" && !cancelled && (comingCount > 0 || guestRsvpCount > 0) ? publicCountsEl : null}',
		);
	});

	// protects=the RSVP page's Confirm acts as the page's member, per slot, and
	// only while the answer is Coming; fails_when=memberId is dropped, the slot
	// is swapped, or the Coming gate goes; no_claim=the server accepts it.
	it("the RSVP page confirms through confirmSlot with memberId (#1612)", () => {
		const rsvp = squash(
			readSource(
				resolve(__dirname, "club.$clubId_.meeting.$meetingId.rsvp.tsx"),
			),
		);
		expect(rsvp).toContain(
			"await confirmSlot({ data: { slotId, memberId: view.member.id } });",
		);
		expect(rsvp).toContain(
			"onClick={() => void confirmRole(r.slotId, r.roleName)}",
		);
		expect(rsvp).toContain('r.status === "claimed" && answered === "coming"');
	});

	// protects=the meeting page's own Coming confirms held roles for the viewer
	// only; fails_when=the flag is sent for another member or dropped.
	it("the outreach hook sends confirmHeldRoles only for the viewer's own Coming (#1612)", () => {
		const hook = squash(
			readSource(
				resolve(__dirname, "../components/club/use-meeting-outreach.ts"),
			),
		);
		expect(hook).toContain(
			'...(next === "coming" && memberId === myId ? { confirmHeldRoles: true } : {})',
		);
	});
});

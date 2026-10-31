// Wiring guard for the guest-RSVP props on the meeting page and the panel
// (#1444). The route cannot mount in vitest and the panel's pieces are tested
// through their props, which cannot see a WRONG prop: handing the panel the raw
// loader rows, pointing Here at a different write, or loosening the video-link
// gate passes every component test. So the spots are pinned here against the
// comment-blind SOURCE of the two files.
//
// Covers: the panel feeding `pendingExpectedGuests` the DERIVED guest list; the
// route passing `guestRsvps` as `expectedGuests` and `addRollGuest` as Here; the
// "RSVP to get the video link" branch's gate, destination and that it holds no
// URL (AC3); the public counts line's two gates; the loader fields the page
// reads.
// Does NOT cover: that the rendered text shows the right number or label (the
// component and `publicCountsLine` tests), or the page in a browser.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const squash = (s: string) => s.replace(/\s+/g, " ");
const ROUTE = squash(
	readSource(resolve(__dirname, "club.$clubId.meeting.$meetingId.tsx")),
);
const PANEL = squash(
	readSource(
		resolve(__dirname, "../components/club/meeting-attendance-panel.tsx"),
	),
);

describe("the panel's expected guests (#1444, D7)", () => {
	it("lists the RSVP'd guests not yet marked, from the derived roll guests", () => {
		// protects=an offline Here drops the row at once; a removal brings it back
		// fails_when=the raw `expectedGuests` (or the loader rows) is rendered, or
		//   the filter reads another list
		expect(PANEL).toContain(
			"guests={pendingExpectedGuests(expectedGuests, guests)}",
		);
		expect(PANEL).toContain("onHere={onGuestHere}");
	});

	it("shows the plan-mode list only before the roll, and the roll-mode one only on it", () => {
		// fails_when=either gate is dropped: a list in both modes shows an RSVP'd
		//   guest twice, or one that cannot be marked
		expect(PANEL).toContain(
			"{!roll && expectedGuests ? ( <AttendanceExpectedGuests guests={expectedGuests} />",
		);
		expect(PANEL).toContain("{roll && guests && expectedGuests ? (");
	});

	it("counts the expected guests in the plan line", () => {
		// fails_when=the officer's "· N guests" is not fed from the same list
		expect(PANEL).toContain("guestCount: expectedGuests?.length ?? 0,");
	});
});

describe("the route's guest RSVP wiring (#1444)", () => {
	it("hands the panel the officer's RSVP list, and Here is the roll's own guest add", () => {
		// protects=Here uses the once-per-guest, offline-queued write
		// fails_when=Here calls another writer, or the panel gets another list
		expect(ROUTE).toContain("expectedGuests={guestRsvps}");
		expect(ROUTE).toContain(
			"onGuestHere={(guestId) => addRollGuest({ guestId })}",
		);
	});

	it("names an RSVP'd guest the roll has no row for from the RSVP list", () => {
		// fails_when=the optimistic Here row is named "Guest"
		expect(ROUTE).toContain(
			"guestRsvps.find((g) => g.guestId === guestId)?.name",
		);
	});

	it("offers 'RSVP to get the video link' only for a live meeting with a link, and never the URL", () => {
		// protects=AC3: a signed-out visitor sees the offer, not the link
		// fails_when=the gate loses a term (a cancelled or past meeting offers an
		//   RSVP), the link goes elsewhere, or the branch renders the URL
		const gate = "hasJoinLink && !cancelled && !over ? (";
		expect(ROUTE).toContain(gate);
		const start = ROUTE.indexOf(gate);
		const branch = ROUTE.slice(start, ROUTE.indexOf(") : null}", start));
		expect(branch).toContain('to="/club/$clubId/meeting/$meetingId/rsvp"');
		expect(branch).toContain("RSVP to get the video link");
		expect(branch).not.toContain("joinUrl");
		expect(branch).not.toContain("href=");
		// The member's own link stays the first branch, off the page's joinUrl.
		expect(ROUTE).toContain("{joinUrl ? ( <a href={joinUrl}");
	});

	it("reads the guest fields the loader serves", () => {
		// fails_when=the page stops reading the count or the officer's list
		expect(ROUTE).toMatch(/hasJoinLink,\s*guestRsvpCount,\s*guestRsvps,/);
	});

	it("shows the public counts line off the panel, upcoming, not cancelled, with a coming or a guest count", () => {
		// protects=a guests-only meeting still says "2 guests"; never on a past or
		//   cancelled one, never "0 coming"
		// fails_when=either gate loses a term, or the line is not publicCountsLine
		expect(ROUTE).toContain(
			'{!showPanel && phase === "upcoming" && !cancelled && (comingCount > 0 || guestRsvpCount > 0) ? publicCountsEl : null}',
		);
		expect(ROUTE).toContain("{publicCountsLine(comingCount, guestRsvpCount)}");
	});

	it("never fetches the stored link for a non-member editor, and tells the dialog only whether one is set", () => {
		// protects=the roster-picked Toastmaster can edit but is never handed the
		//   link: the dialog gets the withheld payload and `hasJoinLink`
		// fails_when=the route mounts a link reader again, or feeds the dialog a
		//   row with `joinUrl` merged in
		expect(ROUTE).not.toMatch(/JoinUrlFor|editorJoinUrl|metaDialogMeeting/);
		expect(ROUTE).toContain("meeting={meeting} hasJoinLink={hasJoinLink}");
	});
});

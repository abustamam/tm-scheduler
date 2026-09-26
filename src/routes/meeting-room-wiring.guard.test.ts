/**
 * The meeting route's half of the in-room strip (#913).
 *
 * The route is 2,000 lines and needs a router, a query client and a mocked
 * `#/db` to mount, so — like `digital-voting-surfaces.guard.test.ts` — this
 * pins the WIRING in source. The behaviour behind each line is tested where it
 * lives: `validateMeetingRoomSearch` / `isInRoom` against a real router in
 * `src/lib/meeting-hub.test.ts`, and the strip's own visibility, identity and
 * polling matrix in `meeting-room-strip.test.tsx`. What neither can see is
 * whether the route actually hands them the right inputs, which is this file.
 *
 * Comment-blind reads (`readSource`): every check here is must-be-PRESENT, where
 * a comment naming the call would be a bypass.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";
const source = readSource(ROUTE);

describe("the meeting route wires the in-room strip (#913)", () => {
	it("validates search with the pass-through validator, so ?room=1 never 307s", () => {
		expect(source).toMatch(/validateSearch:\s*validateMeetingRoomSearch,/);
	});

	it("shows the strip only on meeting day, off the route's one frozen phase", () => {
		// Both conjuncts: the flag alone would put the strip on an agenda someone
		// kept in a bag and scanned a week later (AC1).
		expect(source).toMatch(
			/const inRoom = isInRoom\(search\) && phase === "today";/,
		);
		expect(source).toMatch(/<MeetingRoomStrip\s+visible=\{inRoom\}/);
	});

	it("derives holdsRole from the same identity the strip is handed", () => {
		expect(source).toMatch(
			/const holdsRole =\s*myId !== null && slots\.some\(\(s\) => s\.assigneeId === myId\);/,
		);
		expect(source).toMatch(/member=\{member\}/);
		expect(source).toMatch(/holdsRole=\{holdsRole\}/);
	});

	it("puts the strip above the toolbar and the agenda", () => {
		const strip = source.indexOf("<MeetingRoomStrip");
		const toolbar = source.indexOf("<MeetingToolbar");
		const agenda = source.indexOf("<MeetingAgenda\n");
		expect(strip, "no <MeetingRoomStrip").toBeGreaterThan(-1);
		expect(toolbar).toBeGreaterThan(strip);
		expect(agenda).toBeGreaterThan(strip);
	});

	it("gives the agenda the anchor the strip's 'Today's agenda' link targets", () => {
		expect(source).toMatch(/id=\{MEETING_AGENDA_ANCHOR_ID\}/);
		// …and wraps the agenda itself, not some other section.
		const anchor = source.indexOf("id={MEETING_AGENDA_ANCHOR_ID}");
		const agenda = source.indexOf("<MeetingAgenda\n", anchor);
		const closes = source.indexOf("</section>", anchor);
		expect(agenda).toBeGreaterThan(anchor);
		expect(closes).toBeGreaterThan(agenda);
	});
});

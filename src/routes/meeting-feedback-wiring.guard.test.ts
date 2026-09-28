/**
 * The meeting route's half of the "Leave feedback" link (#984).
 *
 * The route is 2,000 lines and needs a router, a query client and a mocked
 * `#/db` to mount, so — like `meeting-room-wiring.guard.test.ts` — this pins
 * the WIRING in source. The behaviour is tested where it lives: the window in
 * `feedback-window.test.ts`, the link's open / in-room matrix in
 * `meeting-feedback-link.test.tsx`, the strip's button in
 * `meeting-room-strip.test.tsx`. What none of them can see is whether the
 * route hands them the right inputs.
 *
 * Comment-blind reads (`readSource`): every check here is must-be-PRESENT.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const source = readSource("src/routes/club.$clubId.meeting.$meetingId.tsx");

describe("the meeting route wires the feedback link (#984)", () => {
	it("derives feedbackOpen from feedbackWindow off the route's one frozen clock", () => {
		expect(source).toMatch(
			/const feedbackOpen = feedbackWindow\(meeting, now\)\.canWrite;/,
		);
	});

	it("hands the page link the window AND the strip's own visibility", () => {
		expect(source).toMatch(
			/<MeetingFeedbackLink\s+open=\{feedbackOpen\}\s+inRoom=\{inRoom\}/,
		);
	});

	it("hands the in-room strip the same window", () => {
		const strip = source.indexOf("<MeetingRoomStrip");
		const end = source.indexOf("/>", strip);
		expect(strip).toBeGreaterThan(-1);
		expect(source.slice(strip, end)).toContain("feedbackOpen={feedbackOpen}");
	});
});

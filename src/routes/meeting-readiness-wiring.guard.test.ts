// Route wiring pins for the "Before the meeting" readiness panel (#963): who
// sees it, on which meetings, off which clock, and where it sits.
//
// ## Why this file exists
//
// `canSeeMeetingReadiness` is proved by its own truth table in
// `meeting-readiness.test.ts`, and the panel by `meeting-readiness-panel.test.tsx`.
// Neither can see the call SITE: the table is handed the three flags by the
// route, and the panel is mounted by the route. Every component test injects its
// own props, so each is proved correct about an answer the route may never give
// it (the lesson from #752's ruling gate, `vote-counter-console-wiring.guard.test.ts`).
//
// The wrong values here are SAME-TYPED and in scope, so a swap type-checks and
// lints clean:
//
//   `isTmod: isGrammarian` / `isVoteCounter` ... a different role sees the panel.
//   `canManage: effectiveCanManage` ............ double-applies preview-as-member.
//   `previewAsMember: false` ................... an officer previewing as a member
//                                                still sees an officer's panel (#320).
//   `now` -> `new Date()` ...................... a second clock read in the render,
//                                                which the hydration gate exists to
//                                                catch and `meetingPhase` already
//                                                pins with the page's one `now`.
//
// `club.$clubId.meeting.$meetingId.tsx` cannot be rendered in jsdom (loader plus
// server fns), so the expressions are asserted against the real source.
//
// COMMENT-BLIND (`readSource`): every check is "must be PRESENT", and the route
// documents this call site in prose naming every one of those values.
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";
const src = readSource(ROUTE);

/** The source from `start` to the first `end` after it, or "" when either is missing. */
function slice(start: string, end: string): string {
	const from = src.indexOf(start);
	if (from === -1) return "";
	const to = src.indexOf(end, from);
	return to === -1 ? "" : src.slice(from, to + end.length);
}

describe("the meeting route wires the readiness panel (#963)", () => {
	// Everything between `const readiness =` and its closing `: null;`.
	const decision = slice("const readiness =", ": null;");

	it("finds the readiness decision and the panel's call site at all", () => {
		// Without this a renamed or deleted block makes every slice the empty
		// string and turns each assertion below into a failure that names no cause.
		expect(decision, "expected `const readiness = … : null;`").not.toBe("");
		expect(src.indexOf("<MeetingReadinessPanel")).toBeGreaterThan(-1);
		// Non-vacuity: one expression, not a swallowed half of the file.
		expect(decision.length).toBeLessThan(900);
		expect(decision).not.toContain("MeetingToolbar");
	});

	it("feeds canSeeMeetingReadiness canManage, previewAsMember and isTmod, as themselves", () => {
		// Shorthand properties, so each IS the variable of that name. `canManage`
		// and not `effectiveCanManage`: the helper owns the preview rule, and
		// `isTmod` must survive preview (AC 8's third row).
		expect(decision).toMatch(
			/canSeeMeetingReadiness\(\{\s*canManage,\s*previewAsMember,\s*isTmod\s*\}\)/,
		);
	});

	it("asks showsMeetingReadiness about THIS meeting off the page's one clock", () => {
		const call = slice("showsMeetingReadiness({", "})");
		expect(call).toMatch(/status:\s*meeting\.status/);
		expect(call).toMatch(/scheduledAt:\s*meeting\.scheduledAt/);
		// `timezone` and `now` are the route's own, by shorthand. The helper's `now`
		// is required, so a second clock cannot hide in a default either.
		expect(call).toMatch(/\btimezone,/);
		expect(call).toMatch(/\bnow,/);
		expect(src).not.toMatch(/showsMeetingReadiness\([^)]*new Date\(/);
		// ...and `now` is the render's one clock, the very one `meetingPhase` reads.
		expect(src).toContain("const now = new Date();");
	});

	it("needs BOTH gates: who may see it AND whether the meeting is still to prepare", () => {
		expect(decision).toMatch(
			/canSeeMeetingReadiness\([^)]*\)\s*&&\s*showsMeetingReadiness\(/,
		);
		expect(decision).toMatch(/meetingReadiness\(\{\s*meeting,\s*slots\s*\}\)/);
		expect(decision.trimEnd().endsWith(": null;")).toBe(true);
	});

	it("renders the panel only when the decision produced a readiness, with the route's own keys", () => {
		const tag = slice("<MeetingReadinessPanel", "/>");
		expect(src).toMatch(/\{readiness \? \(\s*<MeetingReadinessPanel/);
		expect(tag).toContain("readiness={readiness}");
		// The club slug and the URL meeting key, the pair `MeetingToolbar`'s own
		// Present link is built from (`clubSlug={clubId}`, `meetingId={urlKey}`).
		expect(tag).toContain("clubId={clubId}");
		expect(tag).toContain("meetingId={urlKey}");
		expect(tag.length).toBeLessThan(300);
	});

	it("puts the panel directly above the agenda section, not inside it", () => {
		const panel = src.indexOf("<MeetingReadinessPanel");
		const anchor = src.indexOf("id={MEETING_AGENDA_ANCHOR_ID}");
		const agenda = src.indexOf("<MeetingAgenda\n");
		expect(panel).toBeGreaterThan(-1);
		expect(anchor).toBeGreaterThan(panel);
		expect(agenda).toBeGreaterThan(anchor);
		// Nothing but the panel's own `: null}` between it and the agenda's section.
		const between = src.slice(panel, src.lastIndexOf("<section", anchor));
		expect(between).not.toContain("<MeetingAgenda");
		expect(between).not.toContain("<MeetingToolbar");
	});
});

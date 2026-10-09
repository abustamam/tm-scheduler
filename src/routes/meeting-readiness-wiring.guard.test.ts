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
//   `previewAsMember: false` ................... an admin previewing as a member
//                                                still sees the admin's panel (#320).
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

/**
 * The source from `start` to the first `end` after it, searched INSIDE
 * `haystack`, or "" when either is missing. The caller passes the construct it
 * means (`decision`, not the whole route): `indexOf` from byte zero finds the
 * first same-named thing in a 2,600-line file, which is not always this one.
 */
function sliceIn(haystack: string, start: string, end: string): string {
	const from = haystack.indexOf(start);
	if (from === -1) return "";
	const to = haystack.indexOf(end, from);
	return to === -1 ? "" : haystack.slice(from, to + end.length);
}

const count = (needle: string): number => src.split(needle).length - 1;

describe("the meeting route wires the readiness panel (#963)", () => {
	// Everything between `const readiness =` and its closing `: null;`.
	const decision = sliceIn(src, "const readiness =", ": null;");
	// The panel's own attribute list.
	const tag = sliceIn(src, "<MeetingReadinessPanel", "/>");

	it("finds the readiness decision and the panel's call site, once each", () => {
		// Without this a renamed or deleted block makes every slice the empty
		// string and turns each assertion below into a failure that names no cause;
		// and a second copy would make `indexOf` pick whichever came first.
		expect(count("const readiness ="), "one `const readiness =`").toBe(1);
		expect(count("<MeetingReadinessPanel"), "one panel element").toBe(1);
		expect(decision, "expected `const readiness = … : null;`").not.toBe("");
		expect(tag, "expected `<MeetingReadinessPanel … />`").not.toBe("");
		// Non-vacuity: one expression, not a swallowed half of the file.
		expect(decision.length).toBeLessThan(1100);
		expect(decision).not.toContain("MeetingToolbar");
		expect(tag.length).toBeLessThan(300);
		expect(tag).not.toContain("<MeetingAgenda");
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
		const call = sliceIn(decision, "showsMeetingReadiness({", "})");
		expect(
			call,
			"expected `showsMeetingReadiness({ … })` in the decision",
		).not.toBe("");
		expect(call).toMatch(/status:\s*meeting\.status/);
		expect(call).toMatch(/scheduledAt:\s*meeting\.scheduledAt/);
		// `timezone` and `now` are the route's own, by shorthand. The helper's `now`
		// is required, so a second clock cannot hide in a default either.
		expect(call).toMatch(/\btimezone,/);
		expect(call).toMatch(/\bnow,/);
		// No clock read anywhere in the decision, not just inside the one call.
		expect(decision).not.toMatch(/new Date\(|Date\.now\(/);
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
		expect(src).toMatch(/\{readiness \? \(\s*<MeetingReadinessPanel/);
		expect(tag).toContain("readiness={readiness}");
		// The club slug and the URL meeting key, the pair `MeetingToolbar`'s own
		// Present link is built from (`clubSlug={clubId}`, `meetingId={urlKey}`).
		expect(tag).toContain("clubId={clubId}");
		expect(tag).toContain("meetingId={urlKey}");
	});

	it("puts the panel directly above the agenda section, not inside it", () => {
		const panel = src.indexOf("<MeetingReadinessPanel");
		// Searched from the panel on: the anchor that matters is the one AFTER it.
		const anchor = src.indexOf("id={MEETING_AGENDA_ANCHOR_ID}", panel);
		expect(panel, "no panel element").toBeGreaterThan(-1);
		expect(
			anchor,
			"the agenda anchor must come after the panel",
		).toBeGreaterThan(panel);
		// The `<section` that carries that anchor. It must open AFTER the panel
		// starts: a panel rendered INSIDE the section puts it before this, and the
		// slice below would then be empty and prove nothing.
		const sectionOpen = src.lastIndexOf("<section", anchor);
		expect(
			sectionOpen,
			"the anchor's <section> must open after the panel's element starts",
		).toBeGreaterThan(panel);
		const between = src.slice(panel, sectionOpen);
		// Non-vacuity: a known neighbour is in it, and it is only the panel's own
		// conditional, so it cannot have swallowed the toolbar or the agenda.
		expect(between.length).toBeGreaterThan(0);
		expect(between).toContain("readiness={readiness}");
		expect(between.length).toBeLessThan(400);
		expect(between).not.toContain("<MeetingAgenda");
		expect(between).not.toContain("<MeetingToolbar");
		// The panel's conditional closes, and nothing but whitespace and the
		// route's own (comment-blanked) `{ }` JSX comment shells follows it
		// before the section opens.
		expect(between).toMatch(/\) : null\}(?:\s*\{\s*\})*\s*$/);
		// ...and the agenda itself is still inside that section.
		expect(src.indexOf("<MeetingAgenda\n", anchor)).toBeGreaterThan(anchor);
	});
});

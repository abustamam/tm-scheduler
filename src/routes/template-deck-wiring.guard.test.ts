/**
 * The template-deck wiring on the two routes that build a deck
 * (#agenda-templates PR 2).
 *
 * ## Why a source guard and not a render test
 *
 * `buildTemplateSlideDeck` and both slide layouts are covered directly, with
 * inputs the test supplies. What no such test can see is the EXPRESSION on the
 * route that decides WHICH builder runs and WHAT rows it gets — the #319 shape:
 * a well-tested component reached through a wrong prop. Mounting either route to
 * observe it means standing up a QueryClientProvider, the identity gate, the
 * commitments query, the attendance rail and the whole agenda; the repo's idiom
 * for a layer vitest cannot otherwise reach is a comment-blind source guard.
 *
 * Three specific reverts this pins, each of which shipped as a real state of
 * this branch during PR 1 and would now be silent:
 *
 * 1. `deck = template ? [] : buildSlideDeck(...)` — PR 1's guard. Correct then,
 *    a regression now: an empty deck is how the export menu used to hide its
 *    deck actions for a contest, so restoring it disables the `.pptx` export for
 *    exactly the meetings this PR added it for.
 * 2. `if (data.template) return <TemplatedMeetingNotice …/>` — PR 1's /present
 *    guard, which returned BEFORE building. Restoring it puts the "not ready
 *    yet" page back in front of a working deck.
 * 3. Passing `slots` where `rows` belongs, or re-deriving rows for the deck
 *    while the sheet reads `flex.rows`. Both typecheck; both let the wall and
 *    the paper disagree about order, which during a contest is a protest.
 *
 * ## Comment-blind, deliberately
 *
 * Every assertion is of the "this pattern must BE present" form, where a comment
 * merely mentioning the pattern is a false PASS — so all of them read through
 * `readSource`, which blanks comments. This file's own header quotes
 * `TemplatedMeetingNotice` and `template ? []`, the exact strings a naive grep
 * would trip over, which is why reading comment-blind is required rather than
 * tidy. (See `src/test/guard-source.ts` for the opposite form, which must NOT.)
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const MEETING = "src/routes/club.$clubId.meeting.$meetingId.tsx";
const PRESENT = "src/routes/club.$clubId_.meeting.$meetingId.present.tsx";

describe("meeting route → deck wiring", () => {
	const src = readSource(MEETING);

	it("builds a templated deck instead of an empty array", () => {
		expect(src).toMatch(/buildTemplateSlideDeck\(/);
		// PR 1's guard, now a regression. Matches the whole `template ? []` shape
		// rather than the bare `[]`, which appears all over a route this size.
		expect(
			src,
			"the deck must no longer be empty for a templated meeting — an empty " +
				"deck is what hid the export menu's deck actions",
		).not.toMatch(/template\s*\?\s*\[\]/);
	});

	it("feeds the deck the SAME rows the printed run sheet uses", () => {
		const m = src.match(/buildTemplateSlideDeck\(\{[\s\S]*?\n\t\t\t\}\)/);
		expect(
			m,
			`no buildTemplateSlideDeck call found in ${MEETING}`,
		).toBeTruthy();
		const call = m?.[0] ?? "";
		// `flex.rows`, not `slots` and not a second `resolveAgendaRows(...)`: the
		// post-flex rows are what every other reader of this meeting sees, and a
		// re-derivation here is a second source of truth for order.
		expect(call, `deck rows must be flex.rows, got: ${call}`).toMatch(
			/rows:\s*flex\.rows/,
		);
		expect(
			call,
			"the deck must not re-derive rows — flex.rows already holds them",
		).not.toMatch(/resolveAgendaRows/);
	});

	it("still builds the STANDARD deck for a meeting with no template", () => {
		// The ternary must keep both arms. A refactor that routed every meeting
		// through the template builder would typecheck and quietly drop the vote
		// slides, the Word of the Day and the functionary intros.
		expect(src).toMatch(/buildSlideDeck\(/);
	});
});

describe("present route → deck wiring", () => {
	const src = readSource(PRESENT);

	it("projects a templated meeting instead of the not-ready notice", () => {
		expect(src).toMatch(/buildTemplateSlideDeck\(/);
		expect(
			src,
			"the PR 1 placeholder must be gone — it returned before building",
		).not.toMatch(/TemplatedMeetingNotice/);
	});

	it("resolves the run sheet's rows for the deck", () => {
		// This route has no `applyFlex`, so unlike the meeting route it must call
		// the shared resolver itself — and it must pass the template through, not
		// null, or it would silently build the STANDARD rows for a contest.
		expect(src).toMatch(/resolveAgendaRows\(\{/);
		const m = src.match(/resolveAgendaRows\(\{[\s\S]*?\}\)/);
		const call = m?.[0] ?? "";
		expect(
			call,
			`resolveAgendaRows must take the template, got: ${call}`,
		).toMatch(/template:\s*data\.template/);
		expect(call, `resolveAgendaRows must take the slots, got: ${call}`).toMatch(
			/slots:\s*data\.slots/,
		);
	});

	it("still builds the STANDARD deck for a meeting with no template", () => {
		expect(src).toMatch(/buildSlideDeck\(/);
	});
});

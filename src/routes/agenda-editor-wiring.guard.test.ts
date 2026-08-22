/**
 * The agenda-editor wiring between the meeting page and its own route
 * (#agenda-templates Phase 2, Task 9).
 *
 * ## Why a source guard and not a render test
 *
 * `AgendaEditor` is covered directly through props (`agenda-editor.test.tsx`),
 * and the server fns it's wired to are covered in Tasks 6-8. What no such test
 * can see is the EXPRESSION that decides whether the "Edit agenda" button is
 * offered at all, and whether the route hands the editor the loader's own data
 * or something re-derived — the #319 shape: a well-tested component reached
 * through a wrong (or wrongly-gated) prop. Neither route can be mounted in
 * vitest (`club.$clubId.meeting.$meetingId_.agenda.tsx` needs a router,
 * loader context and a session), so this repo's idiom for that layer is a
 * comment-blind source guard.
 *
 * Three specific regressions this pins:
 *
 * 1. The button gated on `viewer.canManage` alone. A standard (untemplated)
 *    meeting has no agenda to fork — `getAgendaDraft` returns null for it, and
 *    without the `meeting.templateId` half of the gate every officer would see
 *    an "Edit agenda" button that immediately redirects back to the meeting
 *    page it came from.
 * 2. The loader NOT redirecting on a null draft — an officer would land on a
 *    page with nothing to render (or a runtime crash reading fields off
 *    `null`) instead of bouncing back to the meeting.
 * 3. The route re-deriving `draft` (a second fetch, a stale closure value, or
 *    a hand-built object) instead of passing through what the loader already
 *    fetched and what `router.invalidate()` refreshes after every mutation —
 *    the same class of bug `template-deck-wiring.guard.test.ts` pins for the
 *    slide deck's `rows`.
 *
 * ## Comment-blind, deliberately
 *
 * Every assertion is of the "this pattern must BE present" form, where a
 * comment merely mentioning the pattern is a false PASS — so all of them read
 * through `readSource`, which blanks comments. This file's own header (and the
 * route's own docblock) quote `viewer.canManage`, `redirect(`, and
 * `draft={draft}` — the exact strings a naive grep would trip over — which is
 * why reading comment-blind is required rather than tidy. (See
 * `src/test/guard-source.ts` for the opposite form, which must NOT.)
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const MEETING_AGENDA = "src/components/agenda/meeting-agenda.tsx";
const AGENDA_ROUTE = "src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx";

describe("meeting-agenda → agenda editor button wiring", () => {
	const src = readSource(MEETING_AGENDA);

	it("offers the button only for a templated meeting an officer may manage", () => {
		const m = src.match(
			/\{viewer\.canManage[^}]*?meeting\.templateId[^}]*\? \(/,
		);
		expect(
			m,
			"the button's gate must test BOTH viewer.canManage AND meeting.templateId",
		).toBeTruthy();
	});

	it("links to the agenda route with the meeting's raw id, not a re-derived key", () => {
		const m = src.match(
			/<Link\s+to="\/club\/\$clubId\/meeting\/\$meetingId\/agenda"[\s\S]*?\/>/,
		);
		expect(m, "no Link to the agenda route found").toBeTruthy();
		const call = m?.[0] ?? "";
		expect(
			call,
			`the Link must pass meetingId: meeting.id, got: ${call}`,
		).toMatch(/meetingId:\s*meeting\.id/);
		expect(
			call,
			`the Link must pass clubId: meeting.clubId, got: ${call}`,
		).toMatch(/clubId:\s*meeting\.clubId/);
	});

	it("wraps the Link in an asChild Button, never a bare anchor", () => {
		// The global unlayered `a` rule in src/styles.css beats any layered
		// Tailwind utility and repaints a bare anchor link-teal — three separate
		// bugs already shipped from that rule. `<Button asChild>` is excluded via
		// `:not([data-slot="button"])`; a bare `<Link>` here would not be.
		const m = src.match(
			/<Button[^>]*asChild[^>]*>\s*<Link\s+to="\/club\/\$clubId\/meeting\/\$meetingId\/agenda"/,
		);
		expect(
			m,
			"the agenda Link must be wrapped in <Button asChild>",
		).toBeTruthy();
	});
});

describe("agenda editor route wiring", () => {
	const src = readSource(AGENDA_ROUTE);

	it("redirects to the meeting page when getAgendaDraft returns null", () => {
		expect(src).toMatch(/getAgendaDraft\(/);
		const m = src.match(/if\s*\(!draft\)\s*\{[\s\S]*?\n\t\t\}/);
		expect(
			m,
			"no `if (!draft) { … }` block found after getAgendaDraft",
		).toBeTruthy();
		const block = m?.[0] ?? "";
		expect(block, `the null-draft branch must redirect, got: ${block}`).toMatch(
			/redirect\(/,
		);
		expect(
			block,
			`the redirect must target the canonical meeting route, got: ${block}`,
		).toMatch(/to:\s*"\/club\/\$clubId\/meeting\/\$meetingId"/);
	});

	it("passes the loader's OWN draft to AgendaEditor, not a re-derived value", () => {
		// PR 1's shape for this bug (see template-deck-wiring.guard.test.ts) is a
		// second fetch or a hand-built object sitting between the loader and the
		// component it feeds. `Route.useLoaderData()` must be what `draft` is, and
		// `<AgendaEditor draft={draft} …>` must be what draft becomes.
		expect(src, "the route must read draft straight off the loader").toMatch(
			/const\s+draft\s*=\s*Route\.useLoaderData\(\)/,
		);
		expect(src, "AgendaEditor must be fed that same `draft` binding").toMatch(
			/<AgendaEditor\s+draft=\{draft\}/,
		);
	});

	it("re-fetches after every mutation via router.invalidate()", () => {
		// Without this, a save appears to succeed (the server fn resolved) while
		// the rendered rows silently keep showing the pre-edit state. All six
		// handlers share one `refresh()` helper rather than repeating the
		// invalidate call, so the guard checks that helper calls invalidate, AND
		// that every handler passed to AgendaEditor actually calls it.
		expect(src, "refresh() must call router.invalidate()").toMatch(
			/async function refresh\(\)\s*\{[\s\S]*?router\.invalidate\(\)/,
		);

		const editorBlock =
			src.match(/<AgendaEditor[\s\S]*?\n\t\t\t\/>/)?.[0] ?? "";
		const refreshCalls = editorBlock.match(/refresh\(\)/g) ?? [];
		expect(
			refreshCalls.length,
			`expected each of the 6 mutation handlers (add/update/remove/move row, ` +
				`add/remove role) to call refresh(), found ${refreshCalls.length} in: ${editorBlock}`,
		).toBeGreaterThanOrEqual(6);
	});
});

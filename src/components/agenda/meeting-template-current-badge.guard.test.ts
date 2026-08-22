/**
 * The "Current" badge wiring between the meeting agenda and
 * `MeetingTemplateDialog` (#agenda-templates, Task 3 fix round 1, finding 2).
 *
 * ## Why a source guard and not a render test
 *
 * `MeetingTemplateDialog` itself is thoroughly covered
 * (`meeting-template-dialog.test.tsx`) with a prop it is HANDED — including a
 * case asserting the badge appears when `currentTemplateKey` matches a
 * choice's `key`, and a case asserting it does NOT appear when the value
 * looks like an id instead. What no such test can see is the EXPRESSION at
 * the call site that COMPUTES that prop: the #319 shape (CLAUDE.md), a
 * well-tested component reached through a wrong prop. Mounting
 * `<MeetingAgenda>` inside its real route to observe the wiring means
 * standing up a QueryClientProvider, the identity gate, the offline write
 * queue and the whole agenda; the repo's idiom for a layer vitest cannot
 * otherwise reach is a comment-blind source guard (see
 * `template-deck-wiring.guard.test.ts`, the pattern this file follows).
 *
 * ## The regression this pins
 *
 * Task 3 made `applyTemplateConversion` point a meeting at a PRIVATE
 * per-meeting copy rather than the shared template it was converted from.
 * `meeting-agenda.tsx` kept passing `currentTemplateId={meeting.templateId ??
 * null}` into the dialog, and the dialog matched by `id` — a private copy's
 * id is fresh every conversion and never equals any `listAvailableTemplates`
 * choice's id, so after ANY conversion nothing was ever marked "Current"
 * again: not the template, not "Standard meeting". The dialog is the only
 * surface telling an officer what shape a meeting is in, and no later task in
 * this plan touches it. The fix threads the current template's `key` — which
 * a private copy keeps verbatim from its source (`copyTemplateForMeeting`) —
 * through as its OWN prop, separate from `meeting`, and matches on that
 * instead.
 *
 * ## Comment-blind, deliberately
 *
 * Every assertion is of the "this pattern must BE present" or "this exact
 * broken pattern must be ABSENT" form, where a comment merely naming the
 * pattern is a false pass/fail — this file's own header quotes both the
 * fixed and the broken wiring, which is exactly the text a naive raw grep
 * would trip over. Hence `readSource`.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const AGENDA = "src/components/agenda/meeting-agenda.tsx";
const ROUTE = "src/routes/club.$clubId.meeting.$meetingId.tsx";

describe("meeting agenda → template dialog 'Current' badge wiring", () => {
	const src = readSource(AGENDA);

	it("passes the dialog a KEY, not the meeting's own template id", () => {
		expect(src).toMatch(/currentTemplateKey=\{templateKey\}/);
		// The exact regression shape: matching by id, which a private copy's id
		// (fresh every conversion) can never satisfy again after conversion.
		expect(
			src,
			"currentTemplateId={meeting.templateId...} is back — a private " +
				"per-meeting copy's id never equals a picker choice's id, so " +
				"nothing would ever show as Current again after a conversion",
		).not.toMatch(/currentTemplateId=\{meeting\.templateId/);
	});

	it("declares templateKey as its own prop, not derived from `meeting` inline", () => {
		expect(src).toMatch(/templateKey:\s*string \| null/);
	});
});

describe("meeting route → agenda templateKey wiring", () => {
	const src = readSource(ROUTE);

	it("threads the loader's templateKey through, not a hardcoded value", () => {
		expect(src).toMatch(/templateKey=\{templateKey\}/);
	});
});

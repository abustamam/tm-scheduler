// Route→component wiring pins for the meeting-view chrome (#541 PR 1).
//
// Companion to `minutes-anchor.guard.test.ts`, which pins the three props the
// final #541 review caught mis-wired (`canManage`, `hasIdentity`, and the
// degrade fallback's gate). Same mechanism, same reason, different props: the
// PR moved ~274 lines of inline JSX onto the props of `<MeetingToolbar>` and
// `<MeetingPersonalStrip>`, and `club.$clubId.meeting.$meetingId.tsx` cannot be
// rendered in jsdom (loader + server fns), so NOTHING in the suite observes the
// expressions at the call site. The two components are exhaustively tested
// THROUGH their props, which is precisely the CLAUDE.md trap this closes: a
// component tested through its props cannot see a wrong prop (#319).
//
// Every prop pinned below is (a) same-typed with a sibling prop or a plausible
// wrong expression, so a swap type-checks and lints clean, and (b) silent when
// wrong — the UI still renders, it just does the wrong thing.
//
// COMMENT-BLIND (`readSource`): all assertions are of the "this pattern must BE
// present" form, and this file's own header quotes several of the patterns it
// checks for, so a raw read would keep the suite green with the wiring deleted.
// See `src/test/guard-source.ts`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);

describe("meeting chrome route wiring (#541 D2/D3)", () => {
	// The toolbar takes TWO meeting identifiers, both `string`: the URL key
	// (a club-local date OR a uuid) for the print/present/word LINKS, and the
	// database uuid for the per-meeting role-sheet PDF endpoints. Swapping them
	// type-checks. `meeting-toolbar.test.tsx` proves each prop reaches the right
	// href — it is handed the two values as fixtures and structurally cannot see
	// which one the route puts in which slot.
	it("the toolbar gets the URL key as meetingId (drives the print/present links)", () => {
		expect(
			readSource(ROUTE),
			"the toolbar must get `meetingId={urlKey}` — handing it the uuid still " +
				"resolves, but every shared/printed link stops carrying the pretty " +
				"club-local date the route exists to serve (#336).",
		).toContain("meetingId={urlKey}");
	});

	it("the toolbar gets the DB uuid as dbMeetingId (drives the role-sheet PDFs)", () => {
		expect(
			readSource(ROUTE),
			"the toolbar must get `dbMeetingId={meeting.id}` — with the URL key " +
				"here, `/api/meetings/<date>/role-sheets/…` is not a meeting id and " +
				"every per-meeting PDF in the export menu breaks, silently.",
		).toContain("dbMeetingId={meeting.id}");
	});

	// The availability chip is the ONE mutating control the personal strip owns.
	// `canToggleAvailability` is a plain boolean, so `true` (or `!over`, or
	// `isSignedIn`) type-checks and hands a locked/frozen meeting an enabled
	// chip whose click the server then rejects.
	it("the personal strip's availability gate is the resolved viewer capability", () => {
		expect(
			readSource(ROUTE),
			"the strip must get `canToggleAvailability={viewer.canToggleAvailability}` " +
				"— the viewer is where #150's lock and #393's freeze are already " +
				"resolved; any other expression re-derives them and can disagree.",
		).toContain("canToggleAvailability={viewer.canToggleAvailability}");
	});

	// Two same-signature handlers on adjacent props of the same element. Crossed,
	// "Complete meeting" reopens and "Reopen meeting" completes — both render,
	// both are enabled, and only a live click tells you.
	it("the lifecycle handlers are not crossed", () => {
		const src = readSource(ROUTE);
		expect(
			src,
			"the toolbar's Complete button must call `doComplete` — crossed with " +
				"doReopen it type-checks and the button silently does the opposite.",
		).toContain("onComplete={doComplete}");
		expect(src, "the toolbar's Reopen button must call `doReopen`.").toContain(
			"onReopen={doReopen}",
		);
	});

	// One clock for the render (spec D1). Re-reading `new Date()` inside any of
	// these calls is invisible in every test (they agree ~always) and wrong
	// exactly at club-local midnight, which is the case the single clock exists
	// for: a "today" toolbar over an already-frozen agenda.
	it("phase, freeze and completability all read the SAME injected instant", () => {
		const src = readSource(ROUTE);
		for (const call of [
			"meetingPhase({",
			"isMeetingOver({",
			"resolveMeetingViewer({",
		]) {
			const at = src.indexOf(call);
			expect(
				at,
				`expected a ${call}…}) call in the meeting route`,
			).toBeGreaterThan(-1);
			const args = src.slice(at, src.indexOf("})", at));
			expect(
				args,
				`${call}…}) must be passed the shared \`now\` — without it this ` +
					"consumer reads its own wall clock and the render can straddle " +
					"club-local midnight (spec D1).",
			).toContain("now");
		}
		expect(
			src,
			"`meetingDatePassed` and `meetingDateReached` take `now` positionally " +
				"and default to the live clock when it is omitted.",
		).toContain("meetingDateReached(meeting.scheduledAt, timezone, now)");
		expect(src).toContain(
			"meetingDatePassed(meeting.scheduledAt, timezone, now)",
		);
	});
});

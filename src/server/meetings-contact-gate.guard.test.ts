import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// Structural PII guard (#37): the officer-private loaders must only ever be
// called from a `canManage`-gated branch of loadMeetingDetail, so they are
// never fetched for a public caller. A source-grep guard (like
// server-modules.guard.test.ts) because loadMeetingDetail is private and the
// public-reads tests use a re-implemented mirror — this asserts the REAL file.
//
// `listReachedOutForMeeting` (#340, "who have I asked") used to be in this
// list too: the planned-attendance cutover turned an inline `meeting_outreach`
// query into a named call, and it was NEVER covered before that — deleting its
// `canManage` gate left the whole 3,828-test suite green. PR2 task 6 (absorbing
// OutreachPanel into the planned-attendance panel) removed the call from
// `loadMeetingDetail` entirely: the same reached-out ids now come from `plan`
// (`listPlanForMeetings`, filtered to `reached_out` at the ROUTE), which is
// already canManage-gated the identical way and covered by
// `meetings-plan-payload.integration.test.ts`. Nothing here calls the seam
// function anymore, so it dropped out of this loop rather than being asserted
// absent — this file only knows how to check a call's gating, not police that
// a call never returns.
//
// Comments are blanked first (see `#/test/guard-source`), THEN whitespace is
// collapsed so line-wrapping can't fool it. This test counts calls and asserts
// `gated === total`, and a comment naming either loader skews both counts:
// mentioning `loadHolderContacts(` in prose inflates `total` (a spurious
// failure), and mentioning the whole `canManage ? await loadHolderContacts(`
// phrase inflates `gated` and could hide a real ungated call. Stripping is an
// accuracy fix in both directions. Order matters: collapsing whitespace first
// would fuse comment prose into the code text.
describe("loadMeetingDetail contact gating (#37 PII)", () => {
	const src = readSource(resolve(__dirname, "meetings.ts")).replace(/\s+/g, "");

	for (const fn of ["loadRosterWithContact", "loadHolderContacts"]) {
		it(`${fn} is called only under canManage`, () => {
			const total = src.split(`${fn}(`).length - 1;
			const gated = src.split(`canManage?await${fn}(`).length - 1;
			expect(total).toBeGreaterThan(0); // it IS called
			expect(gated).toBe(total); // and every call is gated
		});
	}

	// The loop above cannot absorb this one: it asserts `gated === total`, and
	// the unavailable list is deliberately UNGATED — a public caller sees who
	// declined, which is the point of the list. So the risk is the opposite
	// shape. Nothing else pins the call: `loadMeetingDetail` is private, and the
	// public-reads mirror calls the seam DIRECTLY, so replacing this expression
	// with a literal `[]` empties the meeting view's "who NOT to chase" list for
	// every club while all 3,828 tests stay green. That is the #319 trap — a
	// module tested only through a mirror cannot see its own wiring.
	it("loadMeetingDetail actually reads the plan for unavailable members", () => {
		expect(src).toContain(
			"unavailableMembers=awaitlistNotComingWithNames(db,meetingId)",
		);
	});

	// Whole-branch review finding I4: deleting `canManage ?` from the `plan`
	// assignment leaks the officer's private chase list on the session-less
	// payload, and every one of the 4104 tests in the suite at the time still
	// passed — the only coverage was a hand-copied duplicate of this expression
	// in `meetings-logic.ts`'s test seam, which cannot see a drift in the REAL
	// loader. These two pin the real file directly, the same shape as the
	// `unavailableMembers` pin above.
	it("withholds the full ladder from a non-managing caller", () => {
		expect(src).toContain("constplan=canManage?allRungs:[]");
	});

	it("never puts the officer-only rung on the public array", () => {
		expect(src).toContain('r.status!=="reached_out"');
	});
});

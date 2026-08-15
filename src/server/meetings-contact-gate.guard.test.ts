import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// Structural PII guard (#37): the officer-private loaders must only ever be
// called from a `canManage`-gated branch of loadMeetingDetail, so they are
// never fetched for a public caller. A source-grep guard (like
// server-modules.guard.test.ts) because loadMeetingDetail is private and the
// public-reads tests use a re-implemented mirror — this asserts the REAL file.
//
// `listReachedOutForMeeting` (#340, "who have I asked") joined this list when
// the planned-attendance cutover turned an inline `meeting_outreach` query into
// a named call. It was NEVER covered before: deleting its `canManage` gate —
// publishing an officer's private chase list on the session-less public meeting
// payload — left the whole 3,828-test suite green. The season-grid twin is
// gated by `includeOutreach` and IS covered; this one had only the mirror,
// which cannot see a wrong call site.
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

	for (const fn of [
		"loadRosterWithContact",
		"loadHolderContacts",
		"listReachedOutForMeeting",
	]) {
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
});

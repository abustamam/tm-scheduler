import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// Structural PII guard (#37): the member/guest contact loaders must only ever be
// called from a `canManage`-gated branch of loadMeetingDetail, so contact is
// never fetched for a public caller. A source-grep guard (like
// server-modules.guard.test.ts) because loadMeetingDetail is private and the
// public-reads tests use a re-implemented mirror — this asserts the REAL file.
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
});

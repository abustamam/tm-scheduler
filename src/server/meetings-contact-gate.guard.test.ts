import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Structural PII guard (#37): the member/guest contact loaders must only ever be
// called from a `canManage`-gated branch of loadMeetingDetail, so contact is
// never fetched for a public caller. A source-grep guard (like
// server-modules.guard.test.ts) because loadMeetingDetail is private and the
// public-reads tests use a re-implemented mirror — this asserts the REAL file.
// Whitespace-stripped so line-wrapping can't fool it.
describe("loadMeetingDetail contact gating (#37 PII)", () => {
	const src = readFileSync(resolve(__dirname, "meetings.ts"), "utf8").replace(
		/\s+/g,
		"",
	);

	for (const fn of ["loadRosterWithContact", "loadHolderContacts"]) {
		it(`${fn} is called only under canManage`, () => {
			const total = src.split(`${fn}(`).length - 1;
			const gated = src.split(`canManage?await${fn}(`).length - 1;
			expect(total).toBeGreaterThan(0); // it IS called
			expect(gated).toBe(total); // and every call is gated
		});
	}
});

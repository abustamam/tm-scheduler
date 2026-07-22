import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PII guard (#37 / PR #284, updated #317, #meeting-key resolver): the PUBLIC
// meeting surfaces must never ship member/guest CONTACT to a visitor not
// entitled to it. `getPublicMeetingByKey` forces canManage=false (no PII); the
// session-based `getMeetingByKey` ships contact only when canManage (admin).
// A source-grep guard (like meetings-contact-gate.guard.test.ts) because the
// leak is in what the loader SHIPS, which a render test can't see.
const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

describe("public meeting routes never ship contact (#37 PII)", () => {
	// Present/print are ALWAYS public (no signed-in shell) — strict: they may load
	// ONLY via getPublicMeetingByKey; a bare getMeetingByKey({ … }) call would
	// leak contact.
	for (const rel of [
		"club.$clubId_.meeting.$meetingId.present.tsx",
		"club.$clubId_.meeting.$meetingId.print.tsx",
	]) {
		it(`${rel} loads via getPublicMeetingByKey only`, () => {
			const src = read(rel);
			expect(src).toMatch(/getPublicMeetingByKey\(\{/);
			// `[^c]` so `getPublicMeetingByKey(` (preceded by 'c') is not a false match.
			expect(src).not.toMatch(/[^c]getMeetingByKey\(\{/);
		});
	}

	// The interactive meeting route MAY load via getMeetingByKey for a signed-in
	// member of the club (#317) so an admin regains management on a share link —
	// but ONLY behind the `context.shell` gate. An anonymous visitor (shell=false)
	// always gets getPublicMeetingByKey (no PII); a signed-in non-admin gets
	// canManage=false (still no PII); only an admin gets contact, which is entitled.
	it("club.$clubId.meeting.$meetingId.tsx gates getMeetingByKey behind context.shell; anon uses getPublicMeetingByKey", () => {
		const src = read("club.$clubId.meeting.$meetingId.tsx");
		// getMeetingByKey is reachable ONLY as the shell branch of this exact ternary.
		expect(src).toMatch(
			/context\.shell\s*\?\s*getMeetingByKey\s*:\s*getPublicMeetingByKey/,
		);
		// …and never as a direct, ungated call.
		expect(src).not.toMatch(/[^c]getMeetingByKey\(\{/);
	});
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PII guard (#37 / PR #284): the PUBLIC meeting routes must load their payload
// via `getPublicMeeting` (which forces canManage=false), NOT the session-based
// `getMeeting`. Otherwise a signed-in admin visiting a public share/present/
// print link would receive member/guest CONTACT in the SSR payload — shipped to
// the client even though nothing renders it. A source-grep guard (like
// meetings-contact-gate.guard.test.ts) because the leak is in what the loader
// SHIPS, which a render test can't see.
const PUBLIC_ROUTES = [
	"club.$clubId.meeting.$meetingId.tsx",
	"club.$clubId_.meeting.$meetingId.present.tsx",
	"club.$clubId_.meeting.$meetingId.print.tsx",
];

describe("public meeting routes never ship contact (#37 PII)", () => {
	for (const rel of PUBLIC_ROUTES) {
		it(`${rel} loads via getPublicMeeting, not session-based getMeeting`, () => {
			const src = readFileSync(resolve(__dirname, rel), "utf8");
			// A call to `getMeeting(` (not `getPublicMeeting(`) would leak contact
			// to an authenticated admin on this public surface. Type-only
			// references (`typeof getPublicMeeting`) are fine.
			expect(src).toMatch(/getPublicMeeting\(\{/);
			expect(src).not.toMatch(/[^c]getMeeting\(\{/);
		});
	}
});

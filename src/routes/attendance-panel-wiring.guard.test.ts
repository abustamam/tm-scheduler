// Route→component wiring pins for the planned-attendance panel (PR 2).
//
// `club.$clubId.meeting.$meetingId.tsx` cannot be rendered in jsdom (loader +
// server fns), so the panel is tested exhaustively THROUGH its props and
// structurally cannot see a wrong one (#319). Every prop pinned here is
// same-typed with a plausible wrong expression, so a swap type-checks and
// lints clean.
//
// COMMENT-BLIND (`readSource`): all assertions are "must BE present", and this
// header quotes the patterns it checks for.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);

describe("attendance panel route wiring (PR 2)", () => {
	const src = readSource(ROUTE);

	it("gates the panel on the phase, not on the over/locked flags", () => {
		// `over`, `locked` and `canComplete` are all booleans in scope here. Only
		// `phase === "upcoming"` is plan mode: `canComplete` is TRUE on meeting day
		// and would keep the plan panel up into roll territory, and `over` is false
		// all through meeting day and would do the opposite. `effectiveCanManage`,
		// never bare `canManage` — #320 drops management everywhere it gates admin
		// UI, including preview-as-member.
		expect(src).toContain("const showPlanPanel = effectiveCanManage");
		expect(src).toContain('phase === "upcoming"');
	});

	it("computes the phase exactly once, on the route's frozen clock", () => {
		// route:346 documents ONE clock for the whole render. A second
		// `meetingPhase(` call — especially one with an inline `new Date()` — lets
		// two components disagree about the club-local day across midnight.
		expect(src.split("meetingPhase({").length - 1).toBe(1);
	});

	it("passes the plan array, the roster, and the shared role map to the panel", () => {
		// `plan` is the admin-only ladder from the loader, not a re-filtered copy.
		// The panel gets `loaderRoster` (the contact-bearing admin roster) rather
		// than the route's `roster` local, which falls back to the client-fetched
		// PUBLIC roster (no phone/email) when `!canManage` — a shape the panel's
		// props require unconditionally. `roleByMemberId` is the ONE map lifted for
		// both the agenda and the panel (#396 PR 2).
		expect(src).toContain("plan={plan}");
		expect(src).toContain("roster={loaderRoster}");
		expect(src).toContain("roleByMemberId={roleByMemberId}");
	});

	it("keeps the agenda column shrinkable so the rail cannot be pushed off", () => {
		expect(src).toContain("min-w-0 flex-1");
	});
});

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
import { readFileSync } from "node:fs";
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
	// RAW (not comment-blanked) — for the one check below whose "must NOT
	// contain" assertion is about COMMENT PROSE itself (M4). `readSource`'s
	// comment-blind stripping would erase the very text that check needs to
	// see, making a "must not contain" assertion pass vacuously either way —
	// the "opposite form" `#/test/guard-source` warns must not read through it.
	const rawSrc = readFileSync(ROUTE, "utf8");

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

	// Task 7: the personal strip's rung is the member's OWN answer, read from the
	// PUBLIC `answeredRungs` array. `plan` is admin-only ([] whenever
	// `!canManage`), so filtering IT by `myId` reads `null` forever for a plain
	// member — they'd answer, the page would reload, and the strip would ask
	// again (the exact bug this guards against).
	it("reads the strip's own rung from the PUBLIC array, never from admin-only `plan`", () => {
		expect(src).toContain("answeredRungs.find");
		expect(src).not.toContain("plan.find((p) => p.memberId === myId)");
	});

	// Carried from the previous task's review: `contactedMemberIds` replaced a
	// server-side SQL filter, and nothing guarded the expression that took its
	// place. A drift to an unfiltered map (or a filter on any status but
	// `reached_out`) would silently mark the wrong members as contacted in the
	// recruit picker.
	it("derives contactedMemberIds by filtering plan on the reached_out status", () => {
		expect(src).toContain('.filter((p) => p.status === "reached_out")');
	});

	// Fix round 1 (Task 7 review): `availBusy={false}` on the strip permanently
	// disabled the busy guard the old `toggleAvailability` had. Concretely: tap
	// "I'll be there", then tap the resulting "undo" before the first request
	// resolves — `setPlannedAttendance` and `clearPlannedAttendance` fire
	// concurrently with no ordering guarantee, and an out-of-order resolution
	// leaves the persisted rung disagreeing with the member's last tap. The
	// panel already guards exactly this class with a per-row `pendingId`
	// (meeting-attendance-panel.tsx:136, 174-181) — this pins the route-level
	// equivalent for the strip's OWN write, since a hardcoded `false` type-checks
	// and lints clean and is invisible to any test that renders the strip alone
	// (its own suite is handed whatever `availBusy` the fixture passes).
	it("guards the strip's own write against a rapid double-tap (no hardcoded availBusy={false})", () => {
		expect(src).not.toContain("availBusy={false}");
		expect(src).toContain("availBusy={myStatusBusy}");
		expect(src).toContain("onSetStatus={setMyStatus}");
		// The busy flag must be set BEFORE the write, and cleared in a `finally` —
		// so a rejected write rolls the rung back (existing `writeRung` behavior)
		// without leaving the strip's control wedged disabled. Checked by relative
		// ORDER and proximity rather than brace-matched slicing, since a
		// `try {…} finally {…}` closes its inner block on the same `}` a naive
		// slice would mistake for the wrapper function's own end.
		const fnStart = src.indexOf("async function setMyStatus(");
		expect(
			fnStart,
			"expected an `async function setMyStatus(...)` wrapper around `writeRung`",
		).toBeGreaterThan(-1);
		const busyTrueAt = src.indexOf("setMyStatusBusy(true)", fnStart);
		const writeRungAt = src.indexOf("await writeRung(", fnStart);
		const finallyAt = src.indexOf("finally", fnStart);
		const busyFalseAt = src.indexOf("setMyStatusBusy(false)", fnStart);
		expect(busyTrueAt).toBeGreaterThan(fnStart);
		expect(writeRungAt).toBeGreaterThan(busyTrueAt);
		expect(finallyAt).toBeGreaterThan(writeRungAt);
		expect(busyFalseAt).toBeGreaterThan(finallyAt);
		// All within the same small wrapper — not a stray, unrelated busy/finally
		// pair found far downstream in the file.
		expect(busyFalseAt - fnStart).toBeLessThan(400);
	});

	// Whole-branch review findings I1-I5, M1, M4, M8: cross-task interactions no
	// single per-task review could see. Each is pinned here for the same reason
	// the rest of this file is — the route cannot mount in jsdom.

	it("I1: rolls a failed write back to what the UI showed, not the loader snapshot", () => {
		// `plan.find(...) ?? null` alone is a guaranteed no-op rollback for a
		// non-manager (`plan` is ALWAYS `[]` for them) and, even for a manager,
		// restores whatever was true at PAGE LOAD rather than the last
		// successful write — because nothing here refetches `plan` before this
		// runs.
		expect(src).not.toContain(
			"const previous = plan.find((p) => p.memberId === memberId)?.status ?? null;",
		);
		expect(src).toContain(
			"answeredRungs.find((r) => r.memberId === memberId)?.status",
		);
	});

	it("I2: tracks in-flight writes and drops a stale override unconditionally, not only on agreement", () => {
		// The old effect deleted an override only `if (server === value)` —
		// backwards, since agreement is the harmless case. An override that
		// DISAGREES with the server is the one that must not be pinned forever.
		expect(src).not.toContain("if (server === value) {");
		expect(src).toContain("pendingWritesRef");
		expect(src).toContain("pendingWritesRef.current.has(memberId)");
	});

	it("I3: invalidates after a successful plan write, fire-and-forget", () => {
		// `await router.invalidate()` here would refetch the whole meeting
		// payload for one chip tap — deliberately fire-and-forget, since the
		// override already holds the optimistic value. But SOME invalidate must
		// fire or `contactedMemberIds` / `unavailableMemberIds` (both derived
		// from loader values) go stale for the recruit picker and the assign
		// sheet after an officer's tap.
		expect(src).toContain("void router.invalidate();");
	});

	it('M1: tags a nudge-triggered ask with via: "nudge", not the manual default', () => {
		expect(src).toContain('writeRung(memberId, "reached_out", "nudge")');
	});

	it("M4: no longer explains itself by pointing at the deleted myUnavailable symbol", () => {
		// The stale reference lived in a COMMENT, so this must check the raw
		// file — `src` has every comment blanked out and would pass this
		// assertion whether or not the comment was ever fixed.
		expect(rawSrc).not.toContain("myUnavailable");
	});

	it("M8: clamps the officer's own reached_out rung before it reaches the personal strip", () => {
		// `rungOverride` is shared with the officer panel: an officer setting
		// their OWN row to `reached_out` must not mislabel their own strip, and
		// — because an officer's clear is unrestricted — the mislabeled "undo"
		// would actually delete that row.
		expect(src).toContain(
			'myEffectiveStatus === "reached_out" ? null : myEffectiveStatus',
		);
	});

	it("I5: the panel sits above the agenda on mobile and beside it on desktop (D4)", () => {
		// The banner/header/toolbar/announcements block runs full width OUTSIDE
		// the two-column row, so it can never be pushed below the panel on
		// desktop; within the row, mobile order is reversed so the panel lands
		// directly beneath the toolbar rather than after the whole agenda column.
		expect(src).toContain("order-1 lg:order-2");
		expect(src).toContain("order-2 min-w-0 flex-1");
	});
});

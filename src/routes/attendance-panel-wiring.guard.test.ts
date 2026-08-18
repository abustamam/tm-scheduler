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
		// all through meeting day and would do the opposite.
		expect(src).toContain("const showPlanPanel = runsThisMeeting");
		expect(src).toContain('phase === "upcoming"');
		// `effectiveCanManage`, never bare `canManage` — #320 drops management
		// everywhere it gates admin UI, including preview-as-member. The TMOD arm
		// (#576) carries its own `!previewAsMember` for the same reason: an officer
		// previewing as a member who ALSO holds the slot would otherwise keep the
		// panel through the preview and defeat the point of it.
		expect(src).toContain(
			"const runsThisMeeting = effectiveCanManage || (isTmod && !previewAsMember)",
		);
	});

	it("computes the phase exactly once, on the route's frozen clock", () => {
		// route:346 documents ONE clock for the whole render. A second
		// `meetingPhase(` call — especially one with an inline `new Date()` — lets
		// two components disagree about the club-local day across midnight.
		expect(src.split("meetingPhase({").length - 1).toBe(1);
	});

	it("passes the plan array, the roster, and the shared role map to the panel", () => {
		// Both arrays come from ONE name each, so the officer path and the TMOD
		// path cannot diverge: `effectivePlan` is the loader's admin-only ladder
		// for an officer and the separately-verified `getTmodPanelData` rows
		// otherwise, and `panelRoster` is the contact-bearing roster from
		// whichever of those two the viewer is entitled to.
		//
		// Neither may fall back to the route's `roster` local, which is the
		// client-fetched PUBLIC roster (no phone/email) when `!canManage` — the
		// panel's props require contact unconditionally, and silently handing it
		// the public shape is how every row renders "No contact on file".
		expect(src).toContain("plan={effectivePlan}");
		// `panelRosterForMode` since the final review's I2 fix: `panelRoster` is
		// still the entitlement-resolved, contact-bearing list pinned below, and
		// roll mode widens it to the union with the members who hold a recorded row
		// (see "unions the departed…" further down). The prop must read the
		// MODE-AWARE local — wired back to `panelRoster` it typechecks, renders, and
		// silently drops a departed member's row again.
		expect(src).toContain("roster={panelRosterForMode}");
		expect(src).toContain("roleByMemberId={roleByMemberId}");
		expect(src).toContain(
			"const effectivePlan = effectiveCanManage ? plan : fetchedPlan;",
		);
		// Whitespace-collapsed rather than a multi-line regex: the formatter wraps
		// this ternary and the exact break points are its business, not this
		// guard's.
		expect(src.replace(/\s+/g, " ")).toContain(
			"const panelRoster = effectiveCanManage ? loaderRoster : (tmodPanelData?.roster ?? []);",
		);
	});

	// #576 review: the TMOD write wiring had no coverage of any kind. Dropping
	// `...actorClaim` from just ONE of the two call sites is the dangerous slip —
	// a Toastmaster's clear would fall back to the self arm, where `onlyFrom`
	// restricts the delete to the self-service rungs, so it becomes a silent
	// WHERE-clause no-op with no thrown error and no toast.
	it("sends the caller's own id on BOTH plan write paths, so the server can verify the TMOD", () => {
		expect(src.replace(/\s+/g, " ")).toContain(
			"const actorClaim = !effectiveCanManage && myId ? { actorMemberId: myId } : {};",
		);
		// Both spread sites, counted rather than matched once — one is inside the
		// clear call and one inside the set call, and a single `toContain` would
		// pass with either deleted.
		expect(src.split("...actorClaim").length - 1).toBe(2);
	});

	it("fetches the Toastmaster's ladder with the viewer's own id, gated on needing it", () => {
		expect(src).toContain(
			"const needsTmodPlan = showPlanPanel && !effectiveCanManage && !!myId;",
		);
		// The ARGUMENTS are the point: the meeting being viewed and the viewer's
		// own id. Passing `memberId: someOtherId` would typecheck and silently ask
		// the server to verify the wrong person. Stops before the closing braces so
		// the formatter's trailing comma is not part of the contract.
		expect(src.replace(/\s+/g, " ")).toContain(
			"getTmodPanelData({ data: { meetingId: meeting.id, memberId: myId as string }",
		);
		expect(src).toContain("enabled: needsTmodPlan,");
	});

	it("refreshes the Toastmaster's query after a write, not just the router loader", () => {
		// The ladder lives in a QUERY, so `router.invalidate()` alone leaves it
		// stale — and the reconciling effect then drops the override back onto the
		// stale row, visibly undoing the tap.
		expect(src).toContain(
			"void queryClient.invalidateQueries({ queryKey: tmodPlanKey });",
		);
	});

	it("never renders the panel from a failed or in-flight Toastmaster fetch", () => {
		// An empty roster renders a header plus a counts line of zeros, which is
		// indistinguishable from "no members" and from "you were just demoted".
		expect(src.replace(/\s+/g, " ")).toContain(
			"const tmodPanelUnavailable = needsTmodPlan && (tmodPanelPending || tmodPanelFailed);",
		);
		// `showPanel` since PR 3 Task 5 — the render gate now covers BOTH modes
		// (`showPlanPanel` for `upcoming`, `showRollPanel` on meeting day), and
		// the TMOD-fetch guard has to sit outside that choice or a failed ladder
		// fetch would still render an empty plan panel.
		expect(src).toContain("{showPanel && !tmodPanelUnavailable ? (");
	});

	it("evicts the Toastmaster's cached contact roster when the viewer changes", () => {
		// Keying on `myId` reads a different key on a switch; it does not remove the
		// old one, and the default gcTime keeps the whole club's phone and email in
		// memory for five minutes on a shared laptop.
		// Presence alone was not enough. Moving this call OUT of the cleanup
		// `return` makes it fire eagerly on mount — evicting the roster it just
		// fetched — and emptying the dep array makes it never fire on an identity
		// change, which is the one moment it exists for. Both leave a bare
		// `toContain` green while the stale-PII-cache bug is back, so pin the whole
		// shape: the call inside the returned cleanup, and `myId` in the deps.
		expect(src.replace(/\s+/g, " ")).toContain(
			'return () => { queryClient.removeQueries({ queryKey: ["tmod-plan", meeting.id] }); }; }, [queryClient, meeting.id, myId]);',
		);
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

	// Its sibling, unpinned until now. `unavailableMembers` is `{id, name}[]`, so
	// a slip to `.map((m) => m.name)` still typechecks as `string[]` against the
	// `unavailableMemberIds: string[]` prop, and `meeting-agenda.tsx` would build
	// its `new Set(unavailableMemberIds)` out of names — silently switching off
	// the "already said no" warning in the recruit picker and the assign sheet
	// for every member. Nothing else can see it: this route does not render in
	// jsdom, and the ids are a call-site COMPUTED prop, which the component's own
	// tests take as their fixture rather than check.
	it("derives unavailableMemberIds from member ids, not names", () => {
		expect(src).toContain("unavailableMembers.map((m) => m.id)");
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
		// …and that the catch block APPLIES it. The two assertions above only pin
		// how `previous` is COMPUTED; deleting the `setRungOverride` call from the
		// catch — which leaves the failed write's optimistic value on screen
		// permanently, the exact bug I1 names — satisfies both of them, and no
		// other test in the repo can see it, since this route does not render in
		// jsdom.
		expect(
			src,
			"the rollback must be applied in the catch block, not merely computed",
		).toContain("setRungOverride((o) => ({ ...o, [memberId]: previous }));");
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
		//
		// `void router\n.invalidate()` since the release moved onto it — still
		// unawaited (the statement is `void`-ed, nothing suspends on it), just
		// with the pending refcount released when the refetch settles rather than
		// when the write did. Matched whitespace-tolerantly because the formatter
		// wraps the chain.
		//
		// Only the POSITIVE is assertable here. A `not.toContain("await
		// router.invalidate()")` reads like the stronger check and is in fact
		// unsatisfiable: this route has ~15 other invalidate call sites and
		// several legitimately await. Switching THIS one to `await` breaks the
		// match below, which is the coverage that was wanted.
		expect(src).toMatch(/void router\s*\n?\s*\.invalidate\(\)/);
	});

	it("releases the in-flight mark when the REFETCH settles, not when the write resolves", () => {
		// Those are different moments, and between them the reconciling effect is
		// free to evict the override: `plan` takes a fresh identity on every
		// loader run and this route has ~15 other `router.invalidate()` call
		// sites. A loader request that started before the write committed and
		// lands in that window reverts a chip the officer just tapped, which
		// reads as "it didn't save" — so they tap again.
		expect(src).toMatch(/\.finally\(\(\) => releasePending\(memberId\)\)/);
		// A `finally` on the try/catch would double-release and drop a CONCURRENT
		// write's refcount, which is the bug the refcount exists to prevent.
		expect(
			src,
			"release on the failure path belongs in the catch — a finally double-releases",
		).not.toMatch(/}\s*finally\s*{\s*releasePending\(memberId\);/);
	});

	it("refcounts in-flight writes rather than tracking a set of member ids", () => {
		// An officer's OWN row carries two controls with two independent busy
		// flags that cannot see each other — the panel chip (`pendingId`) and the
		// personal strip (`myStatusBusy`). With a `Set`, the second write's `add`
		// is a no-op and the FIRST write's release clears the entry while the
		// second is still outstanding, handing the effect an override it may
		// evict before its write has landed.
		expect(src).toContain("useRef<Map<string, number>>(new Map())");
		expect(
			src,
			"a Set cannot represent two concurrent writes to the same member",
		).not.toContain("useRef<Set<string>>(new Set())");

		// The DECLARATION is not the behaviour. Pinning only the `Map<string,
		// number>` type leaves the bug this whole fix exists to prevent fully
		// reachable: a Map driven with Set semantics — `m.delete(memberId)` on
		// every release, no matter the count — passes the two assertions above
		// while the first of two concurrent writes still frees the entry. So pin
		// the arithmetic that makes it a refcount.
		expect(
			src,
			"retainPending must INCREMENT, not just mark present",
		).toContain("m.set(memberId, (m.get(memberId) ?? 0) + 1);");
		expect(
			src,
			"releasePending must DECREMENT and only delete at zero",
		).toMatch(
			/const left = \(m\.get\(memberId\) \?\? 1\) - 1;\s*\n\s*if \(left > 0\) m\.set\(memberId, left\);\s*\n\s*else m\.delete\(memberId\);/,
		);
	});

	it("derives roleByMemberId through slotLabel, not the raw role name", () => {
		// A computed prop, so both consumers (the panel and the agenda) take the
		// finished map as their fixture and cannot see it built wrongly — the
		// repo's "a component tested through its props cannot see a WRONG prop"
		// trap. `slotLabel(s, roleCounts)` is what disambiguates repeated roles
		// ("Speaker 1" / "Speaker 2"); `s.roleName` typechecks identically as a
		// string, renders plausibly, and silently labels every speaker the same.
		expect(src).toContain(
			"roleByMemberId[s.assigneeId] = slotLabel(s, roleCounts);",
		);
	});

	it("markAsked leaves a member who already answered alone", () => {
		// The server-side `demoteFrom` floor stops the WRITE, but this early
		// return is what stops the optimistic override — without it a row showing
		// "Coming" flips to "Asked" on a WhatsApp tap and stays wrong until the
		// refetch lands, which is the same lie the floor exists to prevent, just
		// shorter-lived.
		expect(src).toContain("if (current !== null) return;");
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

	// PR 3 Task 5 — roll mode. Same reason as everything above: the route does
	// not mount in jsdom, and every roll-mode prop on the panel is OPTIONAL by
	// design (a caller that has not wired guests renders nothing rather than an
	// empty group), so forgetting one is SILENT — it neither type-errors nor
	// fails any component test.

	it("derives the panel mode from the phase, with no second clock", () => {
		expect(src.replace(/\s+/g, " ")).toContain(
			'const panelMode = phase === "upcoming" ? "plan" : "roll";',
		);
		// Still exactly one `meetingPhase({` in the file — a second call, especially
		// one with an inline `new Date()`, lets the panel and the agenda disagree
		// about the club-local day across midnight.
		expect(src.split("meetingPhase({").length - 1).toBe(1);
	});

	it("gates ROLL mode on a signed-in admin, NOT on the Toastmaster arm", () => {
		// DP1. `setAttendance` runs `gateAdmin` (requireUser + requireClubRole admin)
		// and `getMinutes` is only reached behind `context.shell`, so a roster-pick
		// Toastmaster has no rows to render and no write that would land. Rendering
		// roll mode for them is a panel of buttons that only error.
		const flat = src.replace(/\s+/g, " ");
		expect(flat).toContain(
			'const showPanel = panelMode === "plan" ? showPlanPanel : showRollPanel;',
		);
		expect(flat).toContain(
			"const showRollPanel = effectiveCanManage && minutes.canEdit;",
		);
		// The TMOD arm must NOT reach roll mode.
		expect(
			flat,
			"runsThisMeeting admits the Toastmaster and must not gate the roll panel",
		).not.toContain("const showRollPanel = runsThisMeeting");
	});

	it("feeds roll mode the recorded rows and the guests from minutes", () => {
		// `minutes` here is the loader's `MinutesResult` wrapper (`{ visible,
		// canEdit, data, program }`), so the rows live one level down on
		// `minutes.data` — which is `null` for a viewer who may not read them.
		expect(src).toContain("attendance={rollAttendance}");
		// Fix round 2 (F3): `guests={minutes.data?.guests}` until this round — the
		// raw loader rows, i.e. the members' F1 bug one control to the right. Both
		// props now name a projected local, and neither may go back to reading
		// `minutes.data` directly.
		expect(src).toContain("guests={rollGuests}");
		// Fix round 1 (F1): these assertions replaced a pin on an inline
		// `(minutes.data?.members ?? []).flatMap(...)`, which read the LOADER's rows
		// only — so offline an officer tapped a chip, the write queued, and nothing
		// visibly moved. Both locals now go through `#/lib/roll-attendance`, which
		// replays the offline queue (and owns the `status === null` drop the dashed
		// suggestion depends on). The guard follows the code here; the projections'
		// BEHAVIOUR is tested in `src/lib/roll-attendance.test.ts`, since this route
		// does not mount in jsdom.
		//
		// ONE literal per local, from the `const` to the closing `);` (fix round 2,
		// F4). Three things have to hold together and pinning them separately let a
		// contrived revert satisfy all of them at once:
		//   - the NAME binding — otherwise `rollAttendance` can be re-assigned from
		//     a differently-spelled inline expression while the projected memo sits
		//     beside it as an unused local, passing every fragment;
		//   - the four ARGUMENTS, same point as the `getTmodPanelData` pin above —
		//     each is same-typed with a plausible wrong expression
		//     (`snapshot: minutes.data`, `queue: []`, `online: true`) that
		//     typechecks, lints clean and silently restores loader-only behaviour;
		//   - the DEP ARRAY, for the same reason the `removeQueries` cleanup pins
		//     its own — `deriveMinutes` structuredClones, so these are memoised, and
		//     a memo missing `offlineMinutes.queue` freezes at whatever the first
		//     render computed, which is byte-identical to having no projection.
		// Whitespace-collapsed because the formatter owns the wrapping.
		expect(src.replace(/\s+/g, " ")).toContain(
			"const rollAttendance = useMemo( () => deriveRollAttendance({ online, minutes: minutes.data, snapshot: offlineMinutes.snapshot, queue: offlineMinutes.queue, }), [online, minutes.data, offlineMinutes.snapshot, offlineMinutes.queue], );",
		);
		expect(src.replace(/\s+/g, " ")).toContain(
			"const rollGuests = useMemo( () => deriveRollGuests({ online, minutes: minutes.data, snapshot: offlineMinutes.snapshot, queue: offlineMinutes.queue, }), [online, minutes.data, offlineMinutes.snapshot, offlineMinutes.queue], );",
		);
		// …and the raw forms must be GONE, not merely joined by the new ones. Each
		// can coexist with its projection and typecheck (an unused local is the only
		// symptom), so the positives above cannot see a revert that leaves a prop
		// wired to the old expression.
		expect(
			src.replace(/\s+/g, " "),
			"the roll rows must come from the offline projection, not straight off the loader",
		).not.toContain("(minutes.data?.members ?? []).flatMap(");
		expect(
			src.replace(/\s+/g, " "),
			"the guests must come from the offline projection too — `AttendanceGuestsGroup` has no optimism of its own",
		).not.toContain("minutes.data?.guests");
	});

	it("routes every roll write through the offline hook, so a bad connection queues", () => {
		// #176's capability. A direct `setAttendance(...)` call here would work online
		// and silently vanish offline — at a meeting, on club wifi.
		//
		// THE SECOND ASSERTION IS THE LOAD-BEARING ONE — do not "simplify" it away.
		// The first cannot fail on its own: two other call sites in this route also
		// `await offlineMinutes.mutate(`, so deleting the ROLL write's queue call
		// leaves it green. Verified by mutation during the branch's final
		// verification pass — only the operation-specific `type: "setAttendance"`
		// line caught it. Keep an op-specific assertion beside any generic one here,
		// or this test stops being able to fail for the write it names.
		expect(src).toContain("await offlineMinutes.mutate(");
		expect(src).toContain('type: "setAttendance",');
		// Exactly ONE instance per meeting (DP3) — a second would race the same queue.
		expect(src.split("useOfflineMinutes({").length - 1).toBe(1);
		expect(
			src.replace(/\s+/g, " "),
			"roll writes must not bypass the queue",
		).not.toMatch(/onSetAttendance=\{\(memberId, status\) => setAttendance\(/);
	});

	// Final whole-branch review. Both findings below are CROSS-TASK: every
	// contributing decision was individually correct and individually reviewed,
	// and the defect only exists where two of them meet — which is precisely the
	// shape no per-task review and no component test can see, and precisely why
	// they are pinned at the wiring.

	it("C1: hands the panel the queue's refusal condition, so a tap is never silently discarded", () => {
		// `useOfflineMinutes.mutate()` REFUSES rather than queues while
		// `busy || draining`, and refuses silently — no toast, no throw. The panel's
		// own disable is PER-ROW (`pendingId`), so without this every other chip
		// stayed tappable during a write and threw the tap away: an officer taking
		// roll on a phone taps down a 25-name roster at conversational pace, each tap
		// costing a round trip plus a full `router.invalidate()`.
		//
		// BOTH halves of the condition, spelled out. `busy` alone typechecks, lints
		// clean, passes the panel's own tests (they are handed whatever `busy` the
		// fixture sets) and leaves the identical hole open for the whole of a
		// reconnect drain — which is a meeting on bad club wifi, the exact situation
		// #176's queue exists for.
		expect(src).toContain(
			"busy={offlineMinutes.busy || offlineMinutes.draining}",
		);
	});

	it("I2: unions the departed members holding a recorded row into ROLL mode's roster only", () => {
		// `loadMinutes` builds its member list as "active roster ∪ any member with a
		// saved attendance row" and computes `minutes.counts` over that union. The
		// panel built rows from the active roster alone, so a member marked present
		// in March who left in April vanished from May's reopened minutes — with the
		// Minutes card's own recorder deleted, invisible everywhere but the PDF — and
		// the panel's counts line disagreed with the PDF and the emailed minutes for
		// one meeting.
		//
		// Fixed HERE, deliberately: `buildRollPanel` is correct as written (it builds
		// from whatever roster it is handed) and `roll-panel.test.ts` pins that a
		// stale row cannot resurrect a name, which is right for an UPCOMING meeting.
		// So the mode branch is load-bearing in both directions — dropping it would
		// resurrect names onto the pre-meeting ladder.
		expect(src).toContain(
			'const panelRosterForMode = panelMode === "roll" ? rollRoster : panelRoster;',
		);
		// `panelRoster` itself is unchanged and still pinned above: it stays the
		// entitlement-resolved contact-bearing list, and the union is layered on top
		// rather than folded into it.
		//
		// ONE literal from the `const` to the closing `);`, for the same three
		// reasons the two projections beside it are pinned that way — the NAME
		// binding, the five ARGUMENTS (each same-typed with a plausible wrong
		// expression: `roster: []`, `snapshot: minutes.data`, `online: true`), and
		// the DEP ARRAY, since a memo missing `panelRoster` freezes on the first
		// render's roster and a departed member reappears or vanishes at random.
		expect(src.replace(/\s+/g, " ")).toContain(
			"const rollRoster = useMemo( () => deriveRollRoster({ roster: panelRoster, online, minutes: minutes.data, snapshot: offlineMinutes.snapshot, queue: offlineMinutes.queue, }), [ panelRoster, online, minutes.data, offlineMinutes.snapshot, offlineMinutes.queue, ], );",
		);
	});
	it("F3: hands the panel the queue's sync lifecycle, off the ONE hook instance", () => {
		// Roll mode is the only surface that records attendance now, so the queue's
		// status display has to be reachable from it. Every field below is
		// same-typed with a plausible wrong source — `draining` and `justSynced`
		// are both booleans on the same object — and the whole `sync` prop is
		// OPTIONAL, so dropping it type-checks, lints, and passes every component
		// test (they supply their own fixture). The officer just silently loses the
		// only thing that says a roll is still sitting unsynced on their phone.
		expect(src).toContain("sync={{");
		expect(src).toContain("queueCount: offlineMinutes.queue.length");
		expect(src).toContain("draining: offlineMinutes.draining");
		expect(src).toContain("syncError: offlineMinutes.syncError");
		expect(src).toContain("justSynced: offlineMinutes.justSynced");
		expect(src).toContain("offlineMinutes.retryDrain()");
	});
	it("F6a: derives myAttendance from the RECORDED rows, never from the plan status (#548)", () => {
		// That expression IS the #548 fix, and nothing watched it: neither
		// `myAttendance` nor `MeetingPersonalStrip` was named anywhere in this file.
		// `myStatus` and `myAttendance` are both nullable status types on the same
		// component, so wiring the strip's "you were marked…" line back to the
		// PLAN rung typechecks, lints, passes every component test — and tells a
		// member they were present because they once said they were coming.
		expect(src).toContain("<MeetingPersonalStrip");
		expect(src).toContain(
			"rollAttendance.find((a) => a.memberId === myId)?.status ??",
		);
		// The negative is the half that catches the revert: the positive above can
		// coexist with a second, wrong expression.
		expect(
			src,
			"myAttendance must never read myStatus/myEffectiveStatus — that is exactly the #548 bug",
		).not.toMatch(/myAttendance=\{[^}]*myStatus/);
	});

	// The PANEL's own JSX, sliced out of the route. Necessary, not tidiness: three
	// components in this file take `clubGuests={clubGuests}` (the Minutes card and
	// the vote console's `TableTopicsCapture` are the other two), so a whole-file
	// `toContain` for that binding stays green when the PANEL's copy is the one
	// deleted — the same unfalsifiable shape the `offlineMinutes.mutate(` pin above
	// documents, caught here by mutation. The two `not.toContain`s are what say the
	// slice really stopped before the next component.
	const panelJsx = (() => {
		const start = src.indexOf("<MeetingAttendancePanel");
		expect(
			start,
			"the route must render <MeetingAttendancePanel",
		).toBeGreaterThan(-1);
		const slice = src.slice(start, src.indexOf("/>", start));
		expect(slice).not.toContain("<MeetingMinutes");
		expect(slice).not.toContain("<TableTopicsCapture");
		return slice;
	})();

	it("F6b: pins the six roll-mode bindings, four of which are OPTIONAL props", () => {
		// Every one of these is droppable in silence. `mode` is required but
		// same-typed with `panelMode`'s two other candidates in scope; the rest are
		// OPTIONAL on the panel, so deleting one at the call site type-checks, lints,
		// and passes every component test — those supply their own fixtures — while
		// turning every tap, or every guest edit, into a no-op with nothing on screen
		// to say so.
		//
		// `mode` and `phaseCompleted` are pinned as EXPRESSIONS, not just names: the
		// route holds `panelMode`, `phase`, `over`, `locked` and `canComplete`, and
		// `phaseCompleted={locked}` is the plausible wrong one — a completed meeting
		// is usually also locked, so it looks right until the meeting-day case, where
		// it drops the contact drafts an officer is mid-chase with.
		expect(panelJsx).toContain("mode={panelMode}");
		expect(panelJsx).toContain('phaseCompleted={phase === "completed"}');
		expect(panelJsx).toContain("clubGuests={clubGuests}");
		expect(panelJsx).toContain("onSetAttendance={writeAttendance}");
		expect(panelJsx).toContain("onAddGuest={addRollGuest}");
		expect(panelJsx).toContain("onRemoveGuest={removeRollGuest}");
	});
});

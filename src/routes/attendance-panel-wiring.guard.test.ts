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
//
// Split with `attendance-rail-wiring.guard.test.ts`: EVERY route→panel prop
// expression is pinned here, `roleByMemberId` included. That sibling owns one
// statement and one only — `const panelRoleByMemberId = buildPanelRoleMap(slots)`,
// the map's CONSTRUCTION — and asserts nothing about the call site. The two
// files used to carry a byte-identical `roleByMemberId={panelRoleByMemberId}`
// assertion while each header told the reader the OTHER one owned it, so
// neither could be edited with confidence. Ownership is now: construction →
// the rail guard, hand-off → here, what is INSIDE the map →
// `attendance-panel.test.ts` (a pure function vitest can call directly).
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

	// The panel's own attribute list, sliced out of the route so every prop
	// assertion below is POSITIONAL rather than a whole-file substring match.
	// This route mounts two components that take same-named props:
	// <MeetingAgenda> (route:~1189) takes `roleByMemberId`, `shareUrl` and
	// `meetingDate` as well. Against the whole file, cleanly SWAPPING a prop
	// between the two call sites leaves the required string present — matched at
	// the AGENDA's tag — and the guard green, which is the same "a test can pin
	// the wrong thing after a rename" failure this file's `roleByMemberId`
	// comment describes, mirrored. Renaming the expected string closed the
	// direction that had already bitten and left the other one open.
	//
	// Ends at the element's self-closing `/>` so the window is the tag and
	// nothing after it; the guard asserts both offsets below rather than
	// trusting a `slice` on a -1.
	const panelTagAt = src.indexOf("<MeetingAttendancePanel");
	const panelTagEnd = src.indexOf("/>", panelTagAt);
	const panelProps = src.slice(panelTagAt, panelTagEnd);

	// The pinned rail's own wrapper, windowed the same way and for the same
	// reason: this route carries dozens of `className` strings, and a whole-file
	// `toContain` on a utility class matches whichever element happens to have
	// it. Ends at the opening tag's `>` — `readSource` blanks the JSX comment
	// that sits between `<aside` and `className`, so the first `>` after the tag
	// name is the tag's own.
	const asideTagAt = src.indexOf("<aside");
	const asideTagEnd = src.indexOf(">", asideTagAt);
	const asideTag = src.slice(asideTagAt, asideTagEnd);

	it("finds the panel's call site at all", () => {
		// The window every prop assertion below reads from. Without this, a
		// renamed or deleted <MeetingAttendancePanel> makes `panelProps` the
		// empty string and turns each of those `toContain`s into an honest
		// failure — but one whose message ("expected '' to contain …") says
		// nothing about the cause. Failing here first names it.
		expect(
			panelTagAt,
			"expected a <MeetingAttendancePanel … /> call site in the route",
		).toBeGreaterThan(-1);
		expect(
			panelTagEnd,
			"expected the panel element to be self-closing (`/>`)",
		).toBeGreaterThan(panelTagAt);
	});

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

	it("passes the plan array, the roster, and the rail's own role map to the panel", () => {
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
		//
		// `panelRoleByMemberId`, NOT the plain `roleByMemberId` string map that
		// <MeetingAgenda> reads — the two used to be the same map, and this
		// assertion originally matched that shared name. Once the panel moved to
		// its own richer `PanelRole` map, `roleByMemberId={roleByMemberId}` kept
		// matching this file too, just at the AGENDA's call site further down —
		// a test can pin the wrong thing after a rename. Renaming the expected
		// string is only half the fix, which is why this reads `panelProps` and
		// not `src`: against the whole file, swapping the two call sites puts
		// `panelRoleByMemberId` on the AGENDA and passes again.
		//
		// `panelRoleByMemberId`'s own construction is not asserted here — that
		// statement belongs to `attendance-rail-wiring.guard.test.ts`, and what
		// is INSIDE the map belongs to `attendance-panel.test.ts`, which can call
		// `buildPanelRoleMap` (`#/lib/attendance-panel`) directly. This
		// assertion's job is only the hand-off: the PANEL gets that map rather
		// than the agenda's.
		expect(panelProps).toContain("plan={effectivePlan}");
		expect(panelProps).toContain("roster={panelRoster}");
		expect(panelProps).toContain("roleByMemberId={panelRoleByMemberId}");
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

	// The panel takes NINE props; this file named `roster` and `plan` and
	// stopped, so six of the nine were guarded by nothing at all. Proven, not
	// theorised: swapping `meetingDate` with `shareUrl` AND setting
	// `onWriteRung={markAsked}` passes `bun run typecheck` cleanly and leaves
	// both guard files and the panel's own suite green. That suite cannot see
	// any of it — the props ARE its fixture (#319). The remaining six are pinned
	// below, so the header's "every route→panel prop" is literal: adding a tenth
	// prop with no assertion is the one gap left, and it is a visible one.

	it("hands the panel the date as the date and the link as the link", () => {
		// Two plain `string`s declared four lines apart (route:561/565), so the
		// swap is same-typed in both directions and nothing downstream narrows
		// them. `buildNudge` interpolates both into one sentence — "are you able
		// to make our ${meetingDate} meeting? Agenda here: ${shareUrl}" — so a
		// swap ships every WhatsApp and mail draft in the rail reading "are you
		// able to make our https://gavelup.app/club/…/meeting/2026-08-19 meeting?
		// Agenda here: Tue 19 Aug", with the subject line wrong the same way.
		// Nothing throws; the first person to notice is the member who gets it.
		//
		// The BARE names, not the agenda's guarded `effectiveCanManage ? … : ""`
		// forms: <MeetingAgenda> renders for plain members too, while the panel
		// only ever mounts for someone who runs the meeting (`showPlanPanel`).
		// Copying the agenda's expression here would strip the link out of every
		// draft the rail sends — and these two assertions fail on it, since
		// neither guarded form contains the bare one as a substring.
		expect(panelProps).toContain("meetingDate={nudgeDate}");
		expect(panelProps).toContain("shareUrl={nudgeShareUrl}");
	});

	it("hands the panel the live override map, so an optimistic chip survives a render", () => {
		// `Readonly<Record<string, PlanStatus | null>>`, so `rungOverride={{}}`
		// type-checks — and so does any other map of that shape. It is the only
		// channel the route has for telling the panel what a chip was just set
		// to: `buildPlanPanel` reads `rungOverride[m.id]` ahead of the server
		// value (meeting-attendance-panel.tsx:308). Blanked, every tap reverts to
		// the loader's snapshot on the very next render — which is the "it didn't
		// save" flicker the override exists to prevent, and the panel's own suite
		// passes whatever map its fixture hands it.
		expect(panelProps).toContain("rungOverride={rungOverride}");
	});

	it("locks the panel on the meeting's STATUS, not on a clock fact", () => {
		// `over`, `datePassed`, `canComplete`, `effectiveCanManage` and
		// `previewAsMember` are all booleans in scope at this call site, so every
		// wrong one type-checks. Only `locked` (`isMeetingLocked(meeting.status)`,
		// route:407) means "this meeting no longer accepts writes" — the rest are
		// facts about the clock. `over` or `datePassed` disables the chips on an
		// editable meeting the moment its start time passes, which is exactly when
		// an officer is still working the rail; and any of them can read false on a
		// completed meeting, which leaves a locked meeting's attendance writable.
		expect(panelProps).toContain("locked={locked}");
	});

	it("wires the two write callbacks to their OWN handlers, which are not interchangeable", () => {
		// The critical one. `onWriteRung` is
		// `(memberId: string, next: PlanStatus | null) => void` and `markAsked` is
		// `(memberId: string) => Promise<void>` — TypeScript accepts a function
		// declaring FEWER parameters, so `onWriteRung={markAsked}` type-checks
		// clean. Every rung pick in the rail would then run `markAsked`, whose
		// first act is `if (current !== null) return;` — so on anyone who has
		// already answered, "Coming"/"Not coming"/"No answer" silently does
		// nothing: the chip completes its disabled round trip and comes back
		// reading what it read before, which the officer reads as "it didn't
		// save", so they tap again. On an unanswered row it writes `reached_out`
		// regardless of which chip was picked, tagged `via: "nudge"` in
		// activity_log. No error, no toast, nothing red in CI.
		expect(panelProps).toContain("onWriteRung={writeRung}");
		// The reverse swap is caught by `tsc` (a 3-parameter function is not
		// assignable to a 1-parameter prop), but the arity asymmetry above is
		// exactly why that is not worth relying on: assignability here is
		// directional, and only one of the two directions is a type error.
		expect(panelProps).toContain("onContacted={markAsked}");
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
		expect(src).toContain("{showPlanPanel && !tmodPanelUnavailable ? (");
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

	it("caps the pinned rail's height and gives it its own scroller", () => {
		// The headline reachability fix of this diff, and it was gated by nothing:
		// deleting both classes left 244/244 route tests green. `lg:sticky` with no
		// cap makes the rail's own height a wall — rows are ~81px, so a 40-member
		// club is a ~3,240px column pinned inside a ~950px viewport, and everything
		// past row ~10 is unreachable because the PAGE scrolls and the pinned rail
		// does not. The cap plus the scroller is what makes the bottom rows
		// reachable at all.
		//
		// Both, not either. `lg:overflow-y-auto` alone on an uncapped element never
		// overflows, so it scrolls nothing; `lg:max-h-…` alone clips the rows it
		// cut off with no way to reach them, which is worse than the bug. Each is
		// inert without the other, so a single `toContain` passes on half a fix.
		//
		// HONEST LIMIT: this pins the MECHANISM — the classes are present on the
		// rail's own element — and never the GEOMETRY. jsdom performs no layout and
		// loads no stylesheet, so nothing in this repo proves the rail actually
		// scrolls, that `calc(100vh-7rem)` clears the `top-24` offset, or that row
		// 40 is reachable on a real viewport. Only a browser can see that.
		expect(
			asideTagAt,
			"expected the pinned rail to still be an <aside …> element",
		).toBeGreaterThan(-1);
		expect(
			asideTagEnd,
			"expected the <aside> opening tag to close",
		).toBeGreaterThan(asideTagAt);
		expect(asideTag).toContain("lg:max-h-[calc(100vh-7rem)]");
		expect(asideTag).toContain("lg:overflow-y-auto");
	});
});

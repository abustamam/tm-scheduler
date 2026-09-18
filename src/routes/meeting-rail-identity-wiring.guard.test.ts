// Route→component wiring pins for the attendance rail's identity affordances
// (#727): the member-name link and the guest-edit dialog.
//
// ## Why this file exists at all
//
// Both gates arrive at the panel as PROPS, and a prop-driven gate is the exact
// shape that ships to the wrong audience with a green suite: every component
// test injects the prop itself, so the component is proved correct about an
// answer the route may never give it. This repo has already paid for that once
// — #319 wired `VisitCta isMember={shell}`, true only for a SIGNED-IN member,
// on a page whose dominant path is the no-auth roster pick, and showed "Planning
// a visit? Guests are always welcome" to members on their own sign-up sheet,
// with 32 new component tests green.
//
// `club.$clubId.meeting.$meetingId.tsx` cannot be rendered in jsdom (loader +
// server fns), so the expressions are asserted against the real source. Every
// value pinned here is same-typed with a plausible wrong one in scope, so a swap
// type-checks and lints clean.
//
// ## Ownership
//
// `attendance-panel-wiring.guard.test.ts` owns every prop that existed before
// #727; this file owns the two #727 added and the query that feeds one of them.
// Split by CHANGE rather than by prop so the older file's window and its
// positional-slicing rationale stay exactly as they were.
//
// COMMENT-BLIND (`readSource`): every assertion is "must BE present", and the
// route documents these gates in prose right beside them, so a raw read would
// keep passing after the expression itself was changed.
// ## Mutation evidence (2026-09-17, run in this worktree)
//
// A guard that has never been seen to fail is a guard nobody has checked. Each
// of these was applied to the route, this file run, and the mutation reverted:
//
//   effectiveCanManage -> canManage on the link prop ................... FAILS
//   `guestEdit={guestEdit}` deleted from the call site ................. FAILS
//   `phoneRaw: g.phoneRaw` -> `g.phone` ................................ FAILS
//   `effectiveCanManage && guestPipeline` -> `guestPipeline` ........... FAILS
//   `enabled` losing either conjunct (phase, or capability) ............ FAILS
//
// Re-run them if you change what is asserted here.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);

describe("meeting rail identity wiring (#727)", () => {
	const src = readSource(ROUTE);

	// The panel's own attribute list, sliced out of the route so the prop
	// assertions are POSITIONAL rather than whole-file substring matches — this
	// route mounts several components and `effectiveCanManage` appears at a dozen
	// of them. Same windowing as the sibling guard, for the same reason.
	const panelTagAt = src.indexOf("<MeetingAttendancePanel");
	const panelTagEnd = src.indexOf("/>", panelTagAt);
	const panelProps = src.slice(panelTagAt, panelTagEnd);

	it("finds the panel's call site at all", () => {
		// Without this, a renamed or deleted <MeetingAttendancePanel> makes
		// `panelProps` the empty string and turns each `toContain` below into an
		// honest failure whose message says nothing about the cause.
		expect(
			panelTagAt,
			"expected a <MeetingAttendancePanel … /> call site in the route",
		).toBeGreaterThan(-1);
		expect(
			panelTagEnd,
			"expected the panel element to be self-closing (`/>`)",
		).toBeGreaterThan(panelTagAt);
	});

	it("gates the member link on effectiveCanManage, not on bare canManage", () => {
		// `canManage`, `effectiveCanManage`, `isSignedIn`, `runsThisMeeting` and
		// `showRollPanel` are all booleans in scope here, and every one of them
		// reads plausibly. `effectiveCanManage` is the one the maintainer's
		// amendment names: #320's preview-as-member must drop this affordance like
		// every other admin one, and bare `canManage` is TRUE throughout a preview.
		expect(panelProps).toContain("canViewMemberDetail={effectiveCanManage}");
	});

	it("passes the guest-edit capability to the panel", () => {
		// OPTIONAL on the panel (a caller that has not wired it renders plain text
		// rather than erroring), so dropping this line type-checks, lints clean and
		// silently removes the control. Nothing but a source assertion can see it.
		expect(panelProps).toContain("guestEdit={guestEdit}");
	});

	it("builds that capability from effectiveCanManage AND the fetched rows", () => {
		// TWO conjuncts, and both are load-bearing. The rows alone are not a
		// permission — a cache entry fetched for one viewer would otherwise arm the
		// control for the next — and the permission alone is not enough to open a
		// dialog, because this form turns a blank field into `null` on save: a
		// dialog opened over rows that have not arrived would WIPE the guest's
		// stored email, phone and goes-by name on the first save.
		expect(src).toContain("const guestEdit =");
		expect(src).toMatch(
			/const guestEdit =\s*effectiveCanManage && guestPipeline/,
		);
	});

	it("refreshes those rows after a save, through the same key it fetched them with", () => {
		// `router.invalidate()` inside the dialog re-runs LOADERS and cannot reach
		// a TanStack Query entry, so without `onSaved` the dialog keeps prefilling
		// the PRE-EDIT contact details and the next save writes them back over the
		// edit that just landed. `GuestEditCapability` requires the field, so
		// omitting it is a type error — what a source assertion adds is that it
		// refreshes the RIGHT key: an `onSaved` pointed at some other query
		// type-checks, runs, and reverts exactly as silently.
		expect(src).toContain("const guestPipelineKey =");
		expect(src).toMatch(
			/onSaved: \(\) =>\s*queryClient\.invalidateQueries\(\{ queryKey: guestPipelineKey \}\)/,
		);
	});

	it("evicts those rows through the SAME key it fetched them with", () => {
		// The guest pipeline carries every club guest's email and phone, so the
		// entry is dropped rather than left to the five-minute default gcTime.
		//
		// Anchored on the NAMED key, not on a `["guest-pipeline", …` literal. The
		// literal version of this assertion was worse than useless: it forced the
		// eviction to hand-write its own copy of the key — so the guard defended
		// the duplication it existed to prevent — and being a prefix match it
		// passed on `["guest-pipeline", meeting.id]`, which evicts nothing at all.
		const at = src.indexOf("removeQueries({ queryKey: guestPipelineKey })");
		expect(
			at,
			"expected the guest-pipeline cache to be evicted through guestPipelineKey",
		).toBeGreaterThan(-1);
		expect(src.slice(at, at + 200)).toContain("myId");
		// The key must be memoised, or it is a new array every render and the
		// effect above tears down and re-runs each time — evicting the query it
		// has just fetched, on every render.
		expect(src).toMatch(/const guestPipelineKey = useMemo\(/);
	});

	it("prefills the dialog from the STORED phone column", () => {
		// `phoneRaw` and `phone` are both `string | null` on the same row and both
		// hold plausible numbers, so binding to the wrong one type-checks and still
		// renders a number. `phone` is coalesced to E.164 — a country-code GUESS —
		// so "415-555-2671 x12" would prefill as "+1415555267112", a number nobody
		// typed, in the dialog opened to fix a NAME.
		expect(src).toContain("phoneRaw: g.phoneRaw");
	});

	it("fetches the guest rows behind the admin-gated pipeline read", () => {
		// NOT off the meeting payload. `clubGuests` there is projected to
		// `{ id, name }` precisely because guest contact has never ridden on this
		// page; widening it would put a visitor's email and phone on every meeting
		// render for everyone the payload reaches. `getGuestPipeline` carries its
		// own `requireUser()` + `requireClubAdminView()`.
		expect(src).toContain("getGuestPipeline({ data: clubUuid })");
		// …and only where the control can appear. BOTH conjuncts: `showRollPanel`
		// is `effectiveCanManage && minutes.canEdit` and says nothing about the
		// phase, so on its own it is true for an admin on an UPCOMING meeting —
		// a page with no Guests group at all — and would pull a club's visitor
		// contact details down on every pre-meeting render. The phase test alone
		// is worse: it would fetch for a viewer with no capability, and the
		// server's refusal is not a reason to have asked.
		const queryAt = src.indexOf("queryKey: guestPipelineKey");
		expect(
			queryAt,
			"expected the guest-pipeline useQuery in the route",
		).toBeGreaterThan(-1);
		expect(src.slice(queryAt, queryAt + 400)).toContain(
			'enabled: panelMode === "roll" && showRollPanel',
		);
	});
});

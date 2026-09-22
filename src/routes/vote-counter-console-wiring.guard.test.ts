// Route→component wiring pins for the Ballot Counter console's ruling gate
// (#752): the two props that decide whether the Disqualify and Undo controls
// are rendered at all.
//
// ## Why this file exists at all
//
// The gate is the server's (`requireSignedInVoteCounter`, `guards.ts`) and it
// refuses independently. What these props decide is whether an account-less
// Ballot Counter REACHES a control that cannot work — a refusal mid-meeting
// with the room watching reads as an outage rather than as policy, which is the
// surface #714 was filed about and the thing AC6 exists to prevent.
//
// That decision arrives at the panel as PROPS, and a prop-driven gate is the
// exact shape that ships to the wrong audience with a green suite: every
// component test in `vote-counter-panel.test.tsx` injects these props itself, so
// the component is proved correct about an answer the route may never give it.
// `meeting-rail-identity-wiring.guard.test.ts` beside this file was written for
// the same reason and records the repo's earlier bill for it (#319).
//
// Both wrong values are SAME-TYPED and in scope at the call site, so a swap
// type-checks, lints clean and changes no test:
//
//   `myId`               is `string | null`, like `managerActorId` — and it is
//                        the localStorage name-pick, non-null for exactly the
//                        anonymous caller the ruling gate refuses. Substituting
//                        it re-opens the bug AC6 is about, and makes the comment
//                        sitting on that very line false.
//   `effectiveCanManage` is `boolean`, like `canManage` — and it is false
//                        throughout #320's preview-as-member, where the server
//                        still grants because it keys off the SESSION. The
//                        milder direction: a previewing admin loses the
//                        controls the gate would have allowed.
//
// `club.$clubId.meeting.$meetingId.tsx` cannot be rendered in jsdom (loader +
// server fns), so the expressions are asserted against the real source.
//
// COMMENT-BLIND (`readSource`): every assertion here is "must BE present", and
// the route documents both props in prose right beside them — including the
// literal strings `managerActorId` and `canManage` — so a raw read would keep
// passing after the expressions themselves were changed. That is not
// hypothetical for this file: the call site carries a nine-line comment naming
// both correct values and both wrong ones.
//
// ## Mutation evidence (2026-09-22, run in this worktree)
//
// Each was applied to the route, this file run, and the mutation reverted.
// The three route substitutions all survived the FULL 8,401-test suite before
// this guard existed, which is why it exists:
//
//   sessionMemberId={managerActorId} -> {myId} ......................... FAILS
//   sessionMemberId={managerActorId} -> {myId ?? "x"} .................. FAILS
//   canManageClub={canManage} -> {effectiveCanManage} .................. FAILS
//   the `sessionMemberId=` line deleted entirely ....................... FAILS
//   the `canManageClub=` line deleted entirely ......................... FAILS
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

describe("vote counter console ruling-gate wiring (#752)", () => {
	const src = readSource(ROUTE);

	// The panel's own attribute list, sliced out of the route so the assertions
	// are POSITIONAL rather than whole-file substring matches. `managerActorId`
	// appears at half a dozen other call sites in this route and `canManage` at a
	// dozen, so an unwindowed `toContain` would be satisfied by a NEIGHBOUR's
	// correct prop while this one was wrong — the #565 over-capture shape.
	const tagAt = src.indexOf("<VoteCounterPanel");
	const tagEnd = src.indexOf("/>", tagAt);
	const props = src.slice(tagAt, tagEnd);

	it("finds the console's call site at all", () => {
		// Without this, a renamed or deleted <VoteCounterPanel> makes `props` the
		// empty string and turns every assertion below into an honest failure whose
		// message says nothing about the cause.
		expect(
			tagAt,
			"expected a <VoteCounterPanel … /> call site in the route",
		).toBeGreaterThan(-1);
		expect(
			tagEnd,
			"expected the panel element to be self-closing (`/>`)",
		).toBeGreaterThan(tagAt);
	});

	it("feeds sessionMemberId from managerActorId, never from myId", () => {
		// `managerActorId` is `session?.id ?? null` — the session's own membership
		// id in this club — which is the value `resolveVoteCounterAuthz` binds
		// against server-side, so the console's prediction and the gate's answer
		// agree by construction. `myId` is `useEffectiveMember`'s answer, which
		// falls back to the localStorage name-pick when there is no session: it is
		// NON-NULL for precisely the caller the gate refuses.
		expect(props).toContain("sessionMemberId={managerActorId}");
	});

	it("feeds canManageClub from canManage, not from effectiveCanManage", () => {
		// The admin arm, predicted on its own because it has different evidence: a
		// `read_write` impersonating superadmin is granted by `resolveAdminGrant`
		// before the self-assert arm is reached and has NO `effectiveMemberId`, so
		// `managerActorId` is null for them.
		//
		// `canManage` and not `effectiveCanManage`, for the reason `declineFreesRoles`
		// states elsewhere in this route: the server keys off the SESSION, and an
		// admin previewing as a member (#320) still carries one.
		expect(props).toContain("canManageClub={canManage}");
	});

	// Non-vacuity for the two assertions above. Both are `toContain`, which a
	// slice that accidentally swallowed the whole file would also satisfy — and
	// this route is 2,000 lines with `canManage` on dozens of them. Bounding the
	// window is what makes the positional claim mean anything.
	it("slices only this one element", () => {
		expect(props.length).toBeGreaterThan(0);
		expect(props.length).toBeLessThan(2000);
		expect(props).toContain("<VoteCounterPanel");
		expect(props).not.toContain("<TableTopicsCapture");
	});
});

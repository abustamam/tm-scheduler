import { describe, expect, it } from "vitest";
import {
	CONVERT_DEMOTED_MESSAGE,
	CONVERT_OFFICER_TERM_CLOSED_MESSAGE,
	CONVERT_REACTIVATED_MESSAGE,
	convertNoticeDescription,
	isStrandedConvertedGuest,
} from "./guest-convert";
import { ROSTER_CONFLICT_COPY } from "./roster-conflict-copy";

/**
 * The convert toast's description line (#501 + its privilege review).
 *
 * Three facts can be true at once — the wake-up, the demotion that rides it,
 * and the officer term ended beside it (#805) — and which sentences apply is
 * the only conditional logic the UI half of this feature has. It lives in `lib/`
 * precisely so it can be asserted without a database, a toast, or a rendered
 * card: `vp-membership.test.tsx` can only see that the composed string reached
 * sonner, and the integration suite can only see the flags the server set.
 * This file is the one that sees the rule itself.
 */
describe("convertNoticeDescription", () => {
	it("says nothing at all on the ordinary path", () => {
		// A fresh membership, and reuse of one that was already active, both
		// arrive here. A notice that fires on the common path is one admins learn
		// to ignore — and this one has to carry a permission change when it does
		// fire, so being ignorable is the failure that matters.
		expect(
			convertNoticeDescription({
				reactivated: false,
				closedOfficerPositions: [],
			}),
		).toBeUndefined();
	});

	it("stays silent about a demotion that did not ride a reactivation", () => {
		// Unreachable from the server — `demotedFrom` is only ever written on the
		// wake-up path — and pinned anyway, because the sentence is written to sit
		// UNDER the reactivation line ("waking a lapsed membership…"). Emitted
		// alone it would describe an event this code never performs: convert does
		// not demote a sitting admin it merely deduped onto.
		expect(
			convertNoticeDescription({
				reactivated: false,
				demotedFrom: "admin",
				closedOfficerPositions: ["president"],
			}),
		).toBeUndefined();
	});

	it("reports a bare reactivation with the prior status and nothing else", () => {
		const text = convertNoticeDescription({
			reactivated: true,
			closedOfficerPositions: [],
		});

		expect(text).toBe(CONVERT_REACTIVATED_MESSAGE);
		expect(text).toMatch(/inactive/i);
		// The membership was an ordinary member when it lapsed, so nothing was
		// demoted. Claiming otherwise would teach admins that converting always
		// changes permissions, which is how a real warning stops being read.
		expect(text).not.toContain(CONVERT_DEMOTED_MESSAGE);
	});

	it("adds the demotion, with the remedy, when an elevated role was written down", () => {
		const text =
			convertNoticeDescription({
				reactivated: true,
				demotedFrom: "admin",
				closedOfficerPositions: [],
			}) ?? "";

		expect(text).toContain(CONVERT_REACTIVATED_MESSAGE);
		expect(text).toContain(CONVERT_DEMOTED_MESSAGE);
		// An admin who genuinely wanted this person back as an admin has to be
		// able to act on the notice, so it names the screen that does it in one
		// click. Asserted on the copy, not on the flag, because a rewrite that
		// drops the remedy is exactly the regression this guards.
		expect(text).toMatch(/member page/i);
	});

	it("names the offices it ended, in their display labels and canonical order", () => {
		// Effective-admin's other source (#202), now ended rather than reported
		// (#805). The sentence still has to say WHICH offices: this is a
		// governance change the admin may need to put back, and "an officer term"
		// is not something you can act on.
		const text =
			convertNoticeDescription({
				reactivated: true,
				demotedFrom: "admin",
				closedOfficerPositions: ["president", "treasurer"],
			}) ?? "";

		// The LABEL, not the enum value: `vp_education` in a toast is a database
		// column leaking onto a screen.
		expect(text).toContain("President and Treasurer");
		expect(text).not.toMatch(/vp_|sergeant_at_arms/);
		expect(text).toMatch(/full club admin/i);
		// The remedy, asserted on the composed text: a notice that reports an
		// office being vacated without naming where to give it back leaves the
		// admin hunting — the same obligation the demotion line carries.
		expect(text).toMatch(/member page/i);
		// WHAT HAPPENED, which is the half every assertion above is blind to:
		// the four of them are satisfied verbatim by the sentence this replaced
		// ("They still hold an open officer term (President and Treasurer), and
		// every officer is a full club admin…"), which says the exact opposite.
		// A revert to the reporting-only behaviour has to fail HERE.
		expect(text).toMatch(/ended/i);
		expect(text).not.toMatch(/still hold/i);
	});

	it("says 'officer term' for one office and 'officer terms' for several", () => {
		// A Membership may hold several offices at once (Secretary + Treasurer is
		// the common pair), and the plural is the one part of this sentence that
		// is computed rather than written. Getting it from the LIST rather than
		// the joined string is why the message takes positions: a caller that
		// pre-joined the labels has already thrown the count away.
		expect(CONVERT_OFFICER_TERM_CLOSED_MESSAGE(["secretary"])).toContain(
			"open officer term (Secretary)",
		);
		expect(
			CONVERT_OFFICER_TERM_CLOSED_MESSAGE(["secretary", "treasurer"]),
		).toContain("open officer terms (Secretary and Treasurer)");
	});

	it("reports the office even when the role needed no demotion", () => {
		// The dangerous combination the other cases miss: an ordinary member who
		// lapsed while holding an office. Nothing is demoted — there was nothing
		// elevated to demote — and before #805 the wake-up handed back full admin
		// through the open term anyway. Gating the officer sentence on
		// `demotedFrom` would swallow exactly this case.
		const text =
			convertNoticeDescription({
				reactivated: true,
				closedOfficerPositions: ["secretary"],
			}) ?? "";

		expect(text).toContain(CONVERT_REACTIVATED_MESSAGE);
		expect(text).not.toContain(CONVERT_DEMOTED_MESSAGE);
		expect(text).toContain(CONVERT_OFFICER_TERM_CLOSED_MESSAGE(["secretary"]));
	});
});

describe("convertNoticeDescription — shared roster address (#759)", () => {
	it("speaks on a FRESH membership, which used to return before any line", () => {
		// The composer opened with `if (!reactivated) return undefined`, so the
		// one convert this can happen on — a fresh Person, a fresh roster row —
		// was structurally silent. The admin must hear that the address they
		// just wrote has locked two members out.
		expect(
			convertNoticeDescription({
				reactivated: false,
				closedOfficerPositions: [],
				rosterConflict: "shared_address",
			}),
		).toBe(ROSTER_CONFLICT_COPY.shared_address);
	});

	it("rides after the privilege lines when both apply", () => {
		const text =
			convertNoticeDescription({
				reactivated: true,
				demotedFrom: "admin",
				closedOfficerPositions: [],
				rosterConflict: "shared_address",
			}) ?? "";
		expect(text.startsWith(CONVERT_REACTIVATED_MESSAGE)).toBe(true);
		expect(text).toContain(CONVERT_DEMOTED_MESSAGE);
		expect(text.endsWith(ROSTER_CONFLICT_COPY.shared_address)).toBe(true);
	});

	it("still keeps a stray demotion silent without a reactivation", () => {
		// The restructure must not un-gate the privilege half: only the
		// conflict line escapes the `reactivated` gate.
		expect(
			convertNoticeDescription({
				reactivated: false,
				demotedFrom: "admin",
				closedOfficerPositions: ["president"],
				rosterConflict: "shared_address",
			}),
		).toBe(ROSTER_CONFLICT_COPY.shared_address);
	});
});

describe("isStrandedConvertedGuest", () => {
	// Pinned here because `guest-convert.ts` had no unit test at all until the
	// composer above needed one, and this predicate is the seam the server
	// guards and the pipeline card must agree on — them disagreeing is #632.
	it("is true only for joined-with-no-membership", () => {
		expect(
			isStrandedConvertedGuest({
				stage: "joined",
				convertedMembershipId: null,
			}),
		).toBe(true);
		expect(
			isStrandedConvertedGuest({
				stage: "joined",
				convertedMembershipId: "m1",
			}),
		).toBe(false);
		expect(
			isStrandedConvertedGuest({
				stage: "following_up",
				convertedMembershipId: null,
			}),
		).toBe(false);
	});
});

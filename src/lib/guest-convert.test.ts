import { describe, expect, it } from "vitest";
import {
	CONVERT_DEMOTED_MESSAGE,
	CONVERT_OFFICER_TERM_CLOSED_MESSAGE,
	CONVERT_REACTIVATED_MESSAGE,
	convertNoticeDescription,
	isStrandedConvertedGuest,
	JOIN_DATE_MARGIN_MS,
	joinedBeforeConversion,
	UNDO_MEMBERSHIP_EDITED_MESSAGE,
	UNDO_MEMBERSHIP_MERGED_MESSAGE,
	UNDO_OTHER_GUEST_LINKED_MESSAGE,
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

/**
 * The refusal that names the guests still attached to a membership (#1322).
 * Literal expected strings on purpose: a test that built its expectation with
 * the builder itself could not see a defect that is on both sides.
 */
describe("UNDO_OTHER_GUEST_LINKED_MESSAGE", () => {
	const TAIL =
		"so undoing the conversion would delete the member and leave them " +
		"without one. Unlink them, or undo their conversion, first.";

	// protects=the one-guest branch names the guest and agrees in number;
	// fails_when=the singular drops the name or says "are";
	// no_claim=the longer lists (next tests)
	it("names one guest", () => {
		expect(UNDO_OTHER_GUEST_LINKED_MESSAGE(["Amy"])).toBe(
			`Amy is linked to this member too, ${TAIL}`,
		);
	});

	it("joins two guests with and", () => {
		expect(UNDO_OTHER_GUEST_LINKED_MESSAGE(["Amy", "Bob"])).toBe(
			`Amy and Bob are linked to this member too, ${TAIL}`,
		);
	});

	it("lists three guests with commas and a final and", () => {
		expect(UNDO_OTHER_GUEST_LINKED_MESSAGE(["Amy", "Bob", "Cy"])).toBe(
			`Amy, Bob and Cy are linked to this member too, ${TAIL}`,
		);
	});

	it("shows three and counts the rest past three", () => {
		expect(
			UNDO_OTHER_GUEST_LINKED_MESSAGE(["Amy", "Bob", "Cy", "Di", "Ed"]),
		).toBe(`Amy, Bob, Cy and 2 more are linked to this member too, ${TAIL}`);
	});

	// protects=the remedy fits a guest that was CONVERTED onto the member, which
	// cannot be unlinked ("This guest isn't linked to a member"): it has to name
	// undoing that conversion as well;
	// fails_when=the wording goes back to "Unlink them first";
	// no_claim=that the undo of the other guest works (the pipeline suites)
	it("names undoing a conversion as a remedy, not only unlinking", () => {
		expect(UNDO_OTHER_GUEST_LINKED_MESSAGE(["Amy"])).toMatch(
			/Unlink them, or undo their conversion, first\.$/,
		);
	});
});

/**
 * The merged refusal fires from two branches, one of which cannot order the
 * merge against the conversion, so the text must not claim an order (#1322).
 */
describe("UNDO_MEMBERSHIP_MERGED_MESSAGE", () => {
	it("says the member was merged, and not when", () => {
		expect(UNDO_MEMBERSHIP_MERGED_MESSAGE).toBe(
			"This member was merged with another roster entry, so undoing the " +
				"conversion would delete the merged member. Set them inactive or " +
				"former instead.",
		);
		expect(UNDO_MEMBERSHIP_MERGED_MESSAGE).not.toMatch(/after/i);
	});
});

/**
 * The refusal for an admin's status, role or end-date edit after the conversion
 * created the membership (#1322): the delete would discard their decision.
 */
describe("UNDO_MEMBERSHIP_EDITED_MESSAGE", () => {
	it("says an admin changed the status or role, and names the way out", () => {
		expect(UNDO_MEMBERSHIP_EDITED_MESSAGE).toBe(
			"An admin has changed this member's status or role since the " +
				"conversion, so undoing it would discard that decision. Set them " +
				"inactive or former instead.",
		);
	});
});

/**
 * The join-date test that catches a merge the audit log lost (#1322).
 */
describe("joinedBeforeConversion", () => {
	const converted = new Date("2026-10-26T12:00:00Z");
	const ago = (ms: number) => new Date(converted.getTime() - ms);

	it("is false for a membership with no join date", () => {
		expect(joinedBeforeConversion(null, converted)).toBe(false);
	});

	it("is false for a join date at the conversion, or a little off it", () => {
		expect(joinedBeforeConversion(converted, converted)).toBe(false);
		// App clock ahead of or behind the database clock.
		expect(joinedBeforeConversion(ago(-60_000), converted)).toBe(false);
		expect(joinedBeforeConversion(ago(3_600_000), converted)).toBe(false);
	});

	it("is false at exactly the margin and true just past it", () => {
		expect(joinedBeforeConversion(ago(JOIN_DATE_MARGIN_MS), converted)).toBe(
			false,
		);
		expect(
			joinedBeforeConversion(ago(JOIN_DATE_MARGIN_MS + 1), converted),
		).toBe(true);
	});

	it("is true for a join date years before it, the shape of a merged older row", () => {
		expect(
			joinedBeforeConversion(new Date("2019-03-01T00:00:00Z"), converted),
		).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import {
	CONVERT_DEMOTED_MESSAGE,
	CONVERT_OFFICER_ADMIN_MESSAGE,
	CONVERT_REACTIVATED_MESSAGE,
	convertNoticeDescription,
	isStrandedConvertedGuest,
} from "./guest-convert";

/**
 * The convert toast's description line (#501 + its privilege review).
 *
 * Three facts can be true at once — the wake-up, the demotion that rides it,
 * and the officer term that survives both — and which sentences apply is the
 * only conditional logic the UI half of this feature has. It lives in `lib/`
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
				retainedOfficerPositions: [],
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
				retainedOfficerPositions: ["president"],
			}),
		).toBeUndefined();
	});

	it("reports a bare reactivation with the prior status and nothing else", () => {
		const text = convertNoticeDescription({
			reactivated: true,
			retainedOfficerPositions: [],
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
				retainedOfficerPositions: [],
			}) ?? "";

		expect(text).toContain(CONVERT_REACTIVATED_MESSAGE);
		expect(text).toContain(CONVERT_DEMOTED_MESSAGE);
		// An admin who genuinely wanted this person back as an admin has to be
		// able to act on the notice, so it names the screen that does it in one
		// click. Asserted on the copy, not on the flag, because a rewrite that
		// drops the remedy is exactly the regression this guards.
		expect(text).toMatch(/member page/i);
	});

	it("names the office that still grants admin, in its display label", () => {
		// Effective-admin's other source (#202). Convert writes `club_role` down
		// and deliberately leaves officer terms alone, so this sentence is what
		// keeps the one above it from being a lie.
		const text =
			convertNoticeDescription({
				reactivated: true,
				demotedFrom: "admin",
				retainedOfficerPositions: ["president", "treasurer"],
			}) ?? "";

		// The LABEL, not the enum value: `vp_education` in a toast is a database
		// column leaking onto a screen.
		expect(text).toContain("President and Treasurer");
		expect(text).not.toMatch(/vp_|sergeant_at_arms/);
		expect(text).toMatch(/full club admin/i);
	});

	it("warns about the office even when the role needed no demotion", () => {
		// The dangerous combination the other cases miss: an ordinary member who
		// lapsed while holding an office. Nothing is demoted — there was nothing
		// elevated to demote — and the wake-up still hands back full admin
		// through the open term. Gating the officer sentence on `demotedFrom`
		// would swallow exactly this case.
		const text =
			convertNoticeDescription({
				reactivated: true,
				retainedOfficerPositions: ["secretary"],
			}) ?? "";

		expect(text).toContain(CONVERT_REACTIVATED_MESSAGE);
		expect(text).not.toContain(CONVERT_DEMOTED_MESSAGE);
		expect(text).toContain(CONVERT_OFFICER_ADMIN_MESSAGE("Secretary"));
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

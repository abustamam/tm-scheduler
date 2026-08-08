/**
 * The club-index JSX wiring for the guest surfaces (#318 / #319).
 *
 * ## Why a source guard and not a render test
 *
 * `VisitCta` and `AboutClub` are thoroughly unit-tested — with props the test
 * supplies. The bug #319 actually shipped lived in neither component: it was
 * the EXPRESSION on the route that computes one of those props. `VisitCta` was
 * wired `isMember={shell}`, which is true only for a SIGNED-IN member, so a
 * member who identified through the anonymous roster pick — the dominant path
 * in this no-auth product — was shown "Planning a visit? Guests are always
 * welcome" on their own club's sign-up sheet.
 *
 * Rendering `club.$clubId.index.tsx` to observe that boolean would mean
 * standing up a QueryClientProvider, the identity gate, the commitments query
 * and the whole SeasonGrid — a large, brittle fixture for one expression. The
 * repo's own idiom for a layer that vitest cannot otherwise reach is a
 * comment-blind source guard, and this is one: it pins the expression and fails
 * on exactly the revert that matters.
 *
 * ## Comment-blind, deliberately
 *
 * Both assertions below are of the "this pattern must BE present" form, where a
 * comment merely MENTIONING the pattern would produce a false PASS — so both
 * read through `readSource`, which blanks comments. (The opposite form,
 * "the offender list must be empty", must NOT read through it; see the note in
 * `src/test/guard-source.ts`.) The file header above names
 * `isMember={shell}` — the very string a naive grep would trip over — which is
 * exactly why this file has to read comment-blind.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.index.tsx";

describe("club index → guest surface wiring (#318 / #319)", () => {
	const src = readSource(ROUTE);

	/**
	 * The #319 regression, pinned. `member` comes from `useEffectiveMember`,
	 * which resolves BOTH the signed-in session member and the anonymous
	 * localStorage pick; `shell` covers only the former. Reverting to
	 * `hasIdentity={shell}` reintroduces the bug, and before this guard existed
	 * it did so with the entire 3,437-test suite green.
	 */
	it("passes BOTH shell and the anon-picked member into GuestOnboarding", () => {
		const m = src.match(/hasIdentity=\{([^}]*)\}/);
		expect(m, `no hasIdentity= prop found in ${ROUTE}`).toBeTruthy();
		const expr = m?.[1] ?? "";
		expect(
			expr,
			`hasIdentity must consider the anon pick, got: ${expr}`,
		).toMatch(/member/);
		expect(
			expr,
			`hasIdentity must consider the session shell, got: ${expr}`,
		).toMatch(/shell/);
	});

	it("does not use the old member-only prop name", () => {
		// `isMember` was renamed to `hasIdentity` precisely because the old name
		// invited the signed-in-only reading that caused the bug.
		expect(src).not.toMatch(/isMember=/);
	});

	/**
	 * The three guest cards are gated as ONE block. If a future change renders
	 * any of them directly from the route again, it escapes the gate — which is
	 * how "About this club" and "New to Toastmasters?" ended up in a member's
	 * way in the first place.
	 */
	it("renders the guest cards only through GuestOnboarding", () => {
		expect(src).toMatch(/<GuestOnboarding/);
		for (const card of ["AboutClub", "GuestResources", "VisitCta"]) {
			expect(
				src,
				`${card} is rendered directly, escaping the gate`,
			).not.toMatch(new RegExp(`<${card}[\\s/>]`));
		}
	});

	/**
	 * `AboutClub` renders nothing for a null profile, so dropping the prop from
	 * the JSX — as opposed to from the loader, which the loader test covers —
	 * silently removes the block from every public club page with no failure.
	 */
	/**
	 * `AboutClub` renders nothing for a null profile, so dropping the prop from
	 * the JSX — as opposed to from the loader, which the loader test covers —
	 * silently removes the block from every public club page with no failure.
	 * `clubId` is what makes "Meeting roles" resolve to THIS club's guide rather
	 * than the generic article.
	 */
	it("passes the loader's profile and the club through to the block", () => {
		const m = src.match(/<GuestOnboarding[\s\S]*?\/>/);
		expect(m, `no <GuestOnboarding> element found in ${ROUTE}`).toBeTruthy();
		expect(m?.[0]).toMatch(/profile=\{profile\}/);
		expect(m?.[0]).toMatch(/clubName=\{clubName\}/);
		expect(m?.[0]).toMatch(/clubId=\{clubId\}/);
	});
});

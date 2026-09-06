/**
 * The dashboard's JSX wiring for the two surfaces #608 moved out of the route.
 *
 * ## Why a source guard and not a render test
 *
 * `DashboardGreeting` and `SpeechLogDate` are covered thoroughly — with props
 * their own suites supply. Neither can see a WRONG prop, and neither can see
 * the route reintroducing a runtime read beside them. The route itself cannot
 * be rendered at all: it reaches `#/db` through five server fns, which is what
 * made #608 invisible to a 6,000-test suite in the first place. So the
 * reachable gate on the call site is a comment-blind source guard.
 *
 * ## Comment-blind, deliberately — including the negative assertions
 *
 * The "must BE present" assertions read through `readSource` for the usual
 * reason: a comment merely naming the pattern would be a false PASS.
 *
 * The two "must NOT be present" assertions read comment-blind as well, which is
 * the opposite of the default in `src/test/guard-source.ts` — that note says an
 * offender-list guard read raw can only produce a false FAILURE, and so it is
 * here: `dashboard.tsx` carries comments that quote `new Date().getHours()` and
 * `Intl.DateTimeFormat(undefined, …)` verbatim, explaining why neither belongs
 * on the route any more. Read raw, both assertions would fail on the very
 * comments that document them. `club-index-wiring.guard.test.ts` resolved the
 * same collision the same way.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/_authed/dashboard.tsx";

describe("dashboard → hydration-safe wiring (#608)", () => {
	const src = readSource(ROUTE);

	/**
	 * The name expression, pinned whole.
	 *
	 * `|| authUser.email` is not a defensive nicety — it is the branch EVERY
	 * real user takes. Nothing in `src/` writes `user.name`: Better-Auth's
	 * magic-link plugin stores `name || ""` and neither of the two
	 * `signIn.magicLink` call sites passes one, so the stored name is `""` for
	 * every account. Simplify this to `authUser.name` and the H1 on the
	 * most-visited authed page reads "Welcome back, " with nothing after it,
	 * for everyone, with both component suites still green.
	 */
	it("greets by the stored name, falling back to the email", () => {
		expect(src).toContain(
			"<DashboardGreeting name={authUser.name || authUser.email} />",
		);
	});

	/** The speech-log row's own instant, not a re-derived one. */
	it("hands the speech-log date the row's scheduled instant", () => {
		expect(src).toContain("<SpeechLogDate value={l.scheduledAt} />");
	});

	/**
	 * The revert this whole change exists to prevent, in both of its shapes.
	 *
	 * Either one back on the route is a hydration mismatch again, and neither
	 * has a behavioural gate that could catch it there — the components' suites
	 * only see the components. `getHours` is the greeting's shape;
	 * `Intl.DateTimeFormat` is the date's, and the route has no legitimate use
	 * for it now that `dayMon` lives in `SpeechLogDate` (the commitments list
	 * beside it formats through `#/lib/format`, not directly).
	 */
	it("reads neither the clock nor the runtime locale on the route itself", () => {
		expect(src).not.toContain("getHours()");
		expect(src).not.toContain("Intl.DateTimeFormat");
	});
});

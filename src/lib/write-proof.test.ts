/**
 * `#/lib/write-proof` — the matchers, the sign-in link, and the redirect check
 * `/signin` routes through (#761).
 *
 * The matchers are one-liners and they are tested anyway, because the thing
 * that can go wrong is not the comparison: it is the two strings drifting
 * apart. `SIGN_IN_REQUIRED_MESSAGE` IS the wire format — an `Error` subclass
 * does not survive a `createServerFn` round trip — so if the server's text and
 * the client's matcher ever disagree, every refusal silently degrades to a
 * plain toast with no "Sign in" action and nothing fails. The server half of
 * that pairing is pinned in `write-proof.guard.test.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isNotOnRosterError,
	isSignInRequiredError,
	NOT_ON_ROSTER_MESSAGE,
	SIGN_IN_REQUIRED_MESSAGE,
	safeRedirect,
	signInHref,
} from "./write-proof";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");

describe("write-proof error matchers", () => {
	it("recognises each refusal and nothing else", () => {
		expect(isSignInRequiredError(new Error(SIGN_IN_REQUIRED_MESSAGE))).toBe(
			true,
		);
		expect(isNotOnRosterError(new Error(NOT_ON_ROSTER_MESSAGE))).toBe(true);

		// Cross-matching: the two refusals must not answer for each other, or the
		// already-signed-in member gets sent round the magic-link loop.
		expect(isSignInRequiredError(new Error(NOT_ON_ROSTER_MESSAGE))).toBe(false);
		expect(isNotOnRosterError(new Error(SIGN_IN_REQUIRED_MESSAGE))).toBe(false);

		// An ordinary write refusal keeps today's plain toast.
		expect(isSignInRequiredError(new Error("This meeting is locked."))).toBe(
			false,
		);
		// A non-Error throw (a rejected string, an object off the wire).
		expect(isSignInRequiredError(SIGN_IN_REQUIRED_MESSAGE)).toBe(false);
		expect(isNotOnRosterError(null)).toBe(false);
		expect(isSignInRequiredError(undefined)).toBe(false);
	});

	it("matches what the server actually raises, not a copy of it", () => {
		// Source reads on both, deliberately: importing either server module pulls
		// in `#/db`, which throws without `DATABASE_URL` — so a unit test that
		// imported them would be a DB-backed test wearing a unit test's clothes.
		//
		// `requireUser` is the gate behind ~90 POST fns and raises the message
		// verbatim.
		expect(
			readFileSync(resolve(ROOT, "src/server/guards.ts"), "utf8"),
		).toContain(`throw new Error("${SIGN_IN_REQUIRED_MESSAGE}")`);
		// And `slots-logic.ts` ALIASES this constant rather than restating the
		// text — which is the only thing that keeps `confirmSlot`'s refusal
		// matchable after somebody rewords one of the two.
		expect(
			readFileSync(resolve(ROOT, "src/server/slots-logic.ts"), "utf8"),
		).toContain(
			"export const CONFIRM_NEEDS_SIGN_IN_MESSAGE = SIGN_IN_REQUIRED_MESSAGE;",
		);
	});
});

describe("signInHref", () => {
	it("round-trips a path with a query string back through safeRedirect", () => {
		expect(signInHref("/club/abc/meeting/2026-09-20")).toBe(
			"/signin?redirect=%2Fclub%2Fabc%2Fmeeting%2F2026-09-20",
		);
		// The pair has to compose: what the toast encodes is what `/signin` must
		// still accept. Asserting the encoding alone would pass even if the
		// validator rejected every real path.
		const path = "/club/abc/meeting/2026-09-20?tab=agenda&x=1";
		const encoded = signInHref(path).slice("/signin?redirect=".length);
		expect(safeRedirect(decodeURIComponent(encoded))).toBe(path);
	});

	it("encodes the `&` that would otherwise truncate the redirect", () => {
		// The failure this prevents: an unencoded `&` splits the value in half and
		// the user lands somewhere that is not where they were refused.
		const href = signInHref("/a?b=1&c=2");
		expect(href).toBe("/signin?redirect=%2Fa%3Fb%3D1%26c%3D2");
		expect(href).not.toContain("&c=2");
	});
});

describe("safeRedirect", () => {
	it("keeps a same-origin path", () => {
		expect(safeRedirect("/club/x/meeting/y")).toBe("/club/x/meeting/y");
		expect(safeRedirect("/officers?from=toast")).toBe("/officers?from=toast");
	});

	it("refuses an absolute URL", () => {
		expect(safeRedirect("https://evil.example")).toBe("/officers");
		expect(safeRedirect("http://evil.example/x")).toBe("/officers");
		expect(safeRedirect("javascript:alert(1)")).toBe("/officers");
		expect(safeRedirect("evil.example")).toBe("/officers");
	});

	it("refuses a protocol-relative URL, which passes a naive slash check", () => {
		// `//evil.example` starts with `/` and every browser reads it as
		// `https://evil.example`. `/\evil.example` is the same trick with the
		// other slash, which browsers normalise.
		expect(safeRedirect("//evil.example")).toBe("/officers");
		expect(safeRedirect("//evil.example/path")).toBe("/officers");
		expect(safeRedirect("/\\evil.example")).toBe("/officers");
	});

	it("refuses a non-string, and takes a caller's fallback", () => {
		expect(safeRedirect(undefined)).toBe("/officers");
		expect(safeRedirect(42)).toBe("/officers");
		expect(safeRedirect(["/a"])).toBe("/officers");
		expect(safeRedirect("https://evil.example", "/me")).toBe("/me");
	});

	it("is what `/signin` actually validates with", () => {
		// The half a unit test cannot see: a correct function the route does not
		// call. #319's defect was exactly this — both components well covered, the
		// bug in the expression at the call site.
		const route = readFileSync(resolve(ROOT, "src/routes/signin.tsx"), "utf8");
		expect(route).toContain("redirect: safeRedirect(search.redirect)");
		expect(route).toContain("callbackURL: redirect");
	});
});

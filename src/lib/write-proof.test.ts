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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
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
		// COMMENT-BLIND (`readSource`), not `readFileSync`. These are the "must BE
		// present" class, where a comment naming the pattern satisfies a raw
		// `toContain` after the real code is deleted — a false PASS, and the exact
		// bypass `src/test/guard-source.ts` exists to close. Sharper than usual
		// here because #761 itself adds a `signin.tsx` comment naming
		// `safeRedirect`, which a raw read below would have matched.
		//
		// `requireUser` is the gate behind ~90 POST fns and raises the message
		// verbatim.
		expect(readSource(resolve(ROOT, "src/server/guards.ts"))).toContain(
			`throw new Error("${SIGN_IN_REQUIRED_MESSAGE}")`,
		);
		// And `slots-logic.ts` ALIASES this constant rather than restating the
		// text — which is the only thing that keeps `confirmSlot`'s refusal
		// matchable after somebody rewords one of the two.
		expect(readSource(resolve(ROOT, "src/server/slots-logic.ts"))).toContain(
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

	it("refuses the characters URL parsing STRIPS before deciding an origin", () => {
		// The five payloads #761's review measured past the original prefix
		// denylist. ASCII tab, LF and CR are removed by the parser, so each of
		// these becomes `//evil.example` — which is why the check is an allowlist
		// now and not a longer list of forbidden prefixes. Reachable through the
		// query string as `?redirect=/%09/evil.example` and friends.
		for (const payload of [
			"/\t/evil.example",
			"/\n/evil.example",
			"/\r/evil.example",
			"/\t\t/evil.example",
			"/\r\n/evil.example",
		]) {
			expect(safeRedirect(payload)).toBe("/officers");
		}
	});

	it("never resolves off-origin — measured with the WHATWG URL parser", () => {
		// The PROPERTY, not a payload list: whatever this function returns, a
		// browser resolving it against the app's origin must stay on that origin.
		// Using the real parser as the ORACLE is what makes this able to catch a
		// payload nobody thought of — a hand-written expectation per input can
		// only ever re-state the author's model of URL parsing, which is exactly
		// the model that was wrong.
		const base = "https://gavelup.app";
		const payloads = [
			"/club/x/meeting/y",
			"/officers?from=toast&x=1#frag",
			"//evil.example",
			"///evil.example",
			"/\\evil.example",
			"/\\\\evil.example",
			"/\t/evil.example",
			"/\n//evil.example",
			"/\r/evil.example",
			" //evil.example",
			"\t//evil.example",
			"https://evil.example",
			"http://evil.example",
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"evil.example",
			"/%2f%2fevil.example",
			"/%09/evil.example",
			"/\u0000/evil.example",
			"/path/\u2028evil",
			`/${"a".repeat(5000)}`,
			"",
		];
		for (const payload of payloads) {
			const kept = safeRedirect(payload);
			expect(
				new URL(kept, base).origin,
				`safeRedirect(${JSON.stringify(payload)}) returned ${JSON.stringify(kept)}, which resolves off-origin.`,
			).toBe(base);
		}
	});

	it("keeps every path the app can actually produce", () => {
		// The other direction, so the allowlist cannot be tightened into
		// uselessness: a redirect here is `location.pathname + location.search`,
		// already percent-encoded by the browser.
		for (const path of [
			"/",
			"/officers",
			"/club/9f0b.../meeting/2026-09-20",
			"/club/x/meeting/y?tab=agenda&role=Toastmaster",
			"/me?year=2026-2027",
			"/admin/club-settings#logo",
			"/search?q=caf%C3%A9",
			"/a_b-c.d~e/f",
		]) {
			expect(safeRedirect(path)).toBe(path);
		}
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
		// Comment-blind: this file's own comment in `signin.tsx` names
		// `safeRedirect`, so a raw read would pass with the call deleted.
		const route = readSource(resolve(ROOT, "src/routes/signin.tsx"));
		expect(route).toContain("redirect: safeRedirect(search.redirect)");
		// #843 escapes the target for Better Auth's double decode
		// (`#/lib/magic-link-callback`); the value escaped is still the
		// validated one, and an OAuth continuation goes through `safeRedirect`
		// on its way there too.
		expect(route).toContain("callbackURL: magicLinkCallbackURL(redirect)");
		expect(route).toContain("safeRedirect(continuation)");
	});

	it("keeps an OAuth authorize continuation intact (#843)", () => {
		// The URL `/signin` sends a magic link back to when the OAuth provider
		// asked for a sign-in: a same-origin path carrying an encoded
		// `redirect_uri` and `resource`, a `+`-joined scope and a base64url
		// PKCE challenge. It must survive untouched — a future tightening of
		// `REDIRECT_CHARS` or the length cap would otherwise send every
		// connector sign-in to /officers, with nothing failing but the flow.
		const continuation =
			"/api/auth/oauth2/authorize?response_type=code" +
			"&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback" +
			"&state=aB-_c%2Bd%2Fe%3D&client_id=kOjdqUmnrmVBfTCNFXYyRkbaacVBunXn" +
			"&code_challenge=TeL2kvahUkECukK-NLFnpwXqp8sYYuobfmK9MfbAiak" +
			"&code_challenge_method=S256&resource=https%3A%2F%2Fgavelup.app%2Fapi%2Fmcp" +
			"&scope=openid+profile+email+offline_access";
		expect(safeRedirect(continuation)).toBe(continuation);
	});
});

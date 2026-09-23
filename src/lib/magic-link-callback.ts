/**
 * The `callbackURL` to give Better Auth's magic link so it lands on `path`
 * EXACTLY (#843). Client-safe.
 *
 * Measured against `better-auth@1.7.5`, `plugins/magic-link/index.mjs`: the
 * send side writes the value with `url.searchParams.set("callbackURL", …)` —
 * encoded once — and the verify side redirects to
 * `decodeURIComponent(ctx.query.callbackURL)`, where `ctx.query` has ALREADY
 * been decoded once by the router. So every `%XX` in a callback is decoded
 * twice, and the redirect lands somewhere slightly different from where it was
 * asked to.
 *
 * For most of this app that was invisible: a redirect's query rarely holds an
 * escape. For the OAuth flow it is fatal. The provider's `sig` is base64, so
 * `sig=…%2B…` came back as `sig=…+…` — a SPACE once parsed — and the consent
 * POST failed with `invalid_signature` (seen in a real browser, not inferred).
 * A `state` or `redirect_uri` holding `%26` would be split into two
 * parameters the same way.
 *
 * Escaping every `%` as `%25` makes the second decode an exact inverse: it
 * turns each `%25` back into `%` and touches nothing else, because a path that
 * passed `safeRedirect` holds no other character `decodeURIComponent` reads.
 *
 * `magic-link-callback.integration.test.ts` drives a real sign-in through the
 * real handler and asserts where it lands, so the day Better Auth stops
 * double-decoding, that test fails instead of every callback quietly gaining
 * literal `%25`s.
 */
export function magicLinkCallbackURL(path: string): string {
	return path.replaceAll("%", "%25");
}

/**
 * Approve connects the account the consent screen SHOWED, or nothing (#843).
 * Client-safe: the page and the server hook in `src/lib/auth.ts` share it.
 *
 * Better Auth's `/oauth2/consent` records the grant for whichever session
 * cookie arrives with the POST. The signed query is not bound to a user, so a
 * consent screen opened as A, left open while the person signs in as B in
 * another tab, would connect B on Approve while still reading "Signed in as
 * A" — reproduced against the installed provider by the #843 review. The page
 * therefore sends the id of the user it displayed, and the hook refuses the
 * POST unless that is the session's user. A missing field is refused too: this
 * page is the only thing that posts consent, and a check that passes when the
 * field is absent is not a check.
 */

/** The body field the consent page sends and the hook reads. */
export const CONSENT_ACCOUNT_FIELD = "expected_user_id";

/** The OAuth `error` the hook answers a mismatch with; the page names it. */
export const CONSENT_ACCOUNT_CHANGED = "account_changed";

/** True when a consent POST must be refused for naming the wrong account. */
export function consentAccountMismatch(
	body: unknown,
	sessionUserId: string | undefined,
): boolean {
	const expected =
		body && typeof body === "object"
			? (body as Record<string, unknown>)[CONSENT_ACCOUNT_FIELD]
			: undefined;
	return (
		typeof expected !== "string" ||
		expected.length === 0 ||
		!sessionUserId ||
		expected !== sessionUserId
	);
}

/**
 * Proven vs asserted identity, and the two refusals that say which one a write
 * needed (#761).
 *
 * ## The distinction
 *
 * Every write on a public meeting surface arrives with a member id. Two very
 * different callers can send the same one:
 *
 *  - a **signed-in** member of that club, whose id came from their session's own
 *    membership (`proof: "session"`), and
 *  - a caller with no session at all who picked a name out of "Who are you?"
 *    (`proof: "asserted"`), which is the honour-system sign-up sheet ADR-0010
 *    describes and the product genuinely wants.
 *
 * `resolveWriteActor` has always resolved both to a bare member id, so no caller
 * could tell them apart. ADR-0026 draws the line: an asserted caller may **fill
 * a blank**, and anything that removes, overwrites or rules on someone needs a
 * session bound to that member. This module is the client-safe half of that
 * seam — the type, the two refusal strings, and the matchers a toast uses to
 * recognise them coming back off the wire.
 *
 * ## Why the refusals are STRINGS
 *
 * An `Error` subclass does not survive a `createServerFn` round trip: the client
 * receives a plain `Error` carrying only `message` (see `src/lib/timeable-roles.ts`
 * and `src/lib/meeting-errors.ts`, which match the same way). So the message
 * text IS the wire format. Both sides import the constant from here rather than
 * restating it, which is the only thing that stops a reworded server message
 * from silently turning the "Sign in" action back into a plain toast.
 *
 * ## Client-safe
 *
 * No `#/db`, no `pg`, no server import of any kind — `src/components/write-error-toast.ts`
 * and `src/routes/signin.tsx` import it into the browser bundle.
 */

/** How the actor behind a write was established. */
export type WriteProof = "session" | "asserted";

/**
 * "You need a session for this."
 *
 * Byte-identical to what `requireUser` (`src/server/guards.ts:65`) has always
 * thrown, and to `CONFIRM_NEEDS_SIGN_IN_MESSAGE` (`src/server/slots-logic.ts`),
 * which is now an alias of this constant. Changing the text changes the wire
 * format for every caller that matches it — see the module note above.
 */
export const SIGN_IN_REQUIRED_MESSAGE = "You need to be signed in to do that.";

/**
 * "You have a session, but it is not on this club's roster."
 *
 * A distinct refusal because it is a distinct dead end, and offering "Sign in"
 * to someone already signed in is the worst possible answer. Sign-in binding
 * (#756/#758) refuses a member with no email, a Person in two or more clubs
 * (#759) and a shared address; those users get a session with no membership and
 * land exactly here, so the copy points them at the one action that helps.
 */
export const NOT_ON_ROSTER_MESSAGE =
	"Your account isn't linked to this club's roster. Ask an officer to add your email.";

/** True when a server write refused because the caller had no session. */
export function isSignInRequiredError(err: unknown): boolean {
	return err instanceof Error && err.message === SIGN_IN_REQUIRED_MESSAGE;
}

/** True when a server write refused because the caller's session is not on this
 *  club's roster. */
export function isNotOnRosterError(err: unknown): boolean {
	return err instanceof Error && err.message === NOT_ON_ROSTER_MESSAGE;
}

/**
 * The sign-in link that comes back to where the refusal happened.
 *
 * `encodeURIComponent` matters for more than tidiness: the path carries the
 * caller's current query string, and an unencoded `&` would split the redirect
 * value in half and land them somewhere else entirely.
 */
export function signInHref(path: string): string {
	return `/signin?redirect=${encodeURIComponent(path)}`;
}

/** Where a refusal sends someone who has no better idea — the Officer home,
 *  which redirects non-officers on to the member dashboard (#202 / #542). */
export const DEFAULT_SIGN_IN_REDIRECT = "/officers";

/**
 * Keep a `?redirect=` only when it is a path on THIS origin.
 *
 * `/signin` hands its `redirect` straight to Better-Auth as `callbackURL`, and
 * before #761 nothing checked it. Every refusal in the product now links here
 * with a redirect, which turns a route that forwards whatever it is given into
 * a one-click open redirector carrying a freshly-minted magic-link session.
 *
 * Two rejections, and the second is the one a naive check misses:
 *
 *  - anything not starting with `/` — `https://evil.example`, `javascript:…`,
 *    a bare `evil.example`;
 *  - anything starting with `//` — a protocol-relative URL. It passes
 *    "starts with a slash" and every browser reads `//evil.example` as
 *    `https://evil.example`. `/\` is the same trick with the other slash, which
 *    browsers normalise, so it is refused too.
 *
 * Deliberately NOT a `new URL(value, origin)` round trip: that parses on the
 * server too, where `origin` is not what the browser will use, and it silently
 * accepts a same-origin absolute URL — a shape no caller here produces and one
 * more thing to be wrong about.
 */
export function safeRedirect(
	value: unknown,
	fallback: string = DEFAULT_SIGN_IN_REDIRECT,
): string {
	if (typeof value !== "string") return fallback;
	if (!value.startsWith("/")) return fallback;
	if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
	return value;
}

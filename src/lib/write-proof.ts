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
 * seam, and it holds four things:
 *
 *  - the {@link WriteProof} type;
 *  - the four refusal strings a proven-actor gate can raise
 *    ({@link SIGN_IN_REQUIRED_MESSAGE}, {@link NOT_ON_ROSTER_MESSAGE},
 *    {@link MEMBERSHIP_INACTIVE_MESSAGE}, {@link RULING_NEEDS_SESSION_MESSAGE})
 *    and the two matchers a toast uses to
 *    recognise the ones that change how it renders;
 *  - {@link signInHref}, which builds the link a refusal offers;
 *  - {@link safeRedirect} and {@link DEFAULT_SIGN_IN_REDIRECT}, which decide
 *    what `/signin` will accept back — the inverse of `signInHref`, and the
 *    reason it lives beside it rather than in the route.
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

/**
 * "Your membership here is not active."
 *
 * A THIRD refusal, because `membership_status` has exactly two values and a
 * proven-actor gate admits only `active` — so without it a lapsed member is told
 * their account "isn't linked to this club's roster" and to ask an officer to
 * add their email. Their email IS on the roster; the remedy is reactivation, and
 * `guards.ts` already says so in its own words for the other direction ("That
 * member is inactive, reactivate them first."). Splitting the refusals is only
 * worth anything if each one names the fix that actually works, which is the
 * whole argument for not collapsing this back into the one above.
 *
 * Deliberately has NO matcher and no toast branch. Like an ordinary write
 * refusal it wants its own text and no action — which is exactly what
 * `showWriteError`'s default branch already renders — so a matcher would add a
 * case that did nothing but drift.
 */
export const MEMBERSHIP_INACTIVE_MESSAGE =
	"Your membership in this club isn't active. Ask an officer to reactivate it.";

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
 * Every character a redirect may contain: RFC 3986's unreserved set, sub-delims,
 * and the `:@/?#%[]` a path, query and fragment need.
 *
 * An ALLOWLIST, and that is the whole point. The first version of this function
 * was a prefix denylist — not `//`, not `/\` — and #761's review measured five
 * payloads that survived it and still resolved off-origin, because URL parsing
 * STRIPS ASCII tab, LF and CR before it decides what an origin is. So
 * `/<TAB>/evil.example` (reachable as `?redirect=/%09/evil.example`) parses as
 * `//evil.example`. A denylist has to anticipate every character the parser
 * removes; an allowlist only has to name the ones a real path uses, and a
 * control character is not one of them. Whitespace and non-ASCII are refused
 * along with them: what this validates is `location.pathname + location.search`,
 * which the browser has already percent-encoded.
 */
const REDIRECT_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?#%[\]]*$/;

/** Longer than any route this app produces; bounds the work and the log line. */
const MAX_REDIRECT_LENGTH = 2048;

/**
 * Keep a `?redirect=` only when it is a path on THIS origin.
 *
 * `/signin` hands its `redirect` straight to Better-Auth as `callbackURL`, and
 * before #761 nothing in the route checked it. Every refusal in the product now
 * links here with a redirect, which turns a route that forwards whatever it is
 * given into a one-click open redirector carrying a freshly-minted magic-link
 * session.
 *
 * Four conditions, each closing a different escape:
 *
 *  - **a string**, so a repeated `?redirect=` (which arrives as an array) or a
 *    missing one falls back;
 *  - **bounded length**;
 *  - **starts with `/` and not `//`** — a protocol-relative URL passes "starts
 *    with a slash" and every browser reads `//evil.example` as
 *    `https://evil.example`;
 *  - **every character in {@link REDIRECT_CHARS}**, which is what stops the
 *    parser-stripped control characters described there, and `\` with them.
 *
 * Deliberately NOT a `new URL(value, origin)` round trip: that needs an origin,
 * which on the server is not the one the browser will use, and it silently
 * accepts a same-origin ABSOLUTE url — a shape no caller here produces and one
 * more thing to be wrong about. `write-proof.test.ts` uses the URL parser the
 * other way round, as the ORACLE: whatever this returns must resolve on-origin.
 *
 * This is the first line, not the only one. Better-Auth applies its own
 * character allowlist to `callbackURL` and rejected all five of the payloads
 * above on 1.6.22 (measured during #761's review), so nothing was reachable in
 * production. But this function is exported from a general-purpose client-safe
 * module, and the next caller may have no second line at all.
 */
export function safeRedirect(
	value: unknown,
	fallback: string = DEFAULT_SIGN_IN_REDIRECT,
): string {
	if (typeof value !== "string") return fallback;
	if (value.length === 0 || value.length > MAX_REDIRECT_LENGTH) return fallback;
	if (!value.startsWith("/") || value.startsWith("//")) return fallback;
	if (!REDIRECT_CHARS.test(value)) return fallback;
	return value;
}

/**
 * "Ruling a candidate out is not one of the anonymous console's capabilities."
 *
 * A FOURTH refusal, and it is not a variant of {@link SIGN_IN_REQUIRED_MESSAGE}
 * even though both mean "no session". That one is the product's general answer
 * to a write that needs one; this one answers a caller who is holding a console
 * that still works — they can open the vote, close it, read the tally, capture
 * Table Topics and set the winner, and only this one control refused. "You need
 * to be signed in to do that" in the middle of a working console reads as an
 * outage, which is the surface #714 was filed about, so the copy names the
 * capability and both ways back: an officer signing in on this device, or the
 * Ballot Counter signing in as themselves (#752).
 *
 * Exported from here, client-safe, because the CONSOLE has to say the same
 * sentence: `VoteCounterPanel` renders it in place of the Disqualify control
 * when the viewer has no session, and the gate throws it for the hand-crafted
 * POST the UI cannot cover. One constant is what stops the two halves of one
 * policy from being worded differently — the module note above applies, the
 * text IS the wire format.
 *
 * Deliberately has NO matcher and no toast branch, for
 * {@link MEMBERSHIP_INACTIVE_MESSAGE}'s reason: it wants its own text and no
 * action, which `showWriteError`'s default branch already renders. The sign-in
 * route is named IN the sentence rather than offered as a button, because the
 * person who most needs it is not the person holding the phone.
 *
 * **"club admin", not "officer", and the narrowing is measured.** #752 specified
 * this sentence as "ask an officer", which is true of the GATE — the officer
 * retry inside `requireVoteCounterCapability` grants an elected officer holding
 * an open term — and false of the SCREEN. Signing in makes the session win in
 * `useEffectiveMember`, so `myId` stops matching the Vote Counter slot and
 * `isVoteCounter` goes false; `canManage` is `canManageClub`, which is
 * `clubRole === "admin"` or a `read_write` impersonation and does NOT include
 * that officer. Both terms of the console's own section gate are therefore false
 * for them and the whole Ballot Counter console disappears. A refusal that names
 * a route which removes the console is worse than one that names none, so the
 * copy names only what works: a club admin signing in here, or the Ballot
 * Counter signing in as themselves. The officer's unreachable capability is
 * #844; the server grant is unchanged and still asserted.
 */
export const RULING_NEEDS_SESSION_MESSAGE =
	"Ruling a candidate out needs a signed-in club admin — ask an admin to sign in on this device, or sign in yourself.";

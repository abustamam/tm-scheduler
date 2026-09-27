/**
 * Which phone cast a ballot (#765, ADR-0026).
 *
 * The public ballot takes a voter id, and member ids are public: they ship in
 * the ballot payload, and the ballot link is printed as a QR on an agenda that
 * gets shared in club chat. So the voter id alone cannot decide who may CHANGE
 * a vote. The rule is: **the first vote fills a blank, and only the device that
 * cast it, or that member signed in, may change it.** A guest cannot sign in,
 * so a guest's vote can be changed only from the device that cast it.
 *
 * This module is the client-safe half: the per-device token the ballot sends
 * with every `submitVote`, and the two refusal strings `castVote` throws when
 * the device check says no. The strings are the wire format — an `Error`
 * subclass does not survive a `createServerFn` round trip, only `message` does
 * (see `#/lib/write-proof`) — so both sides import them from here.
 *
 * No `#/db`, no server import: `src/components/club/ballot.tsx` imports it.
 */

/** localStorage key for this browser's ballot device token. One per browser,
 *  not per meeting: the token proves "this phone", and the vote row it guards
 *  is already scoped to a session. */
export const BALLOT_DEVICE_KEY = "gavelup:ballot-device";

/** A member's vote was cast from another device and this caller has no session
 *  bound to that member. The ballot offers "Sign in" beside it. */
export const VOTE_CAST_ELSEWHERE_MESSAGE =
	"This ballot was already cast from another device. Sign in to change it.";

/** A guest's vote was cast from another device. Guests cannot sign in, so
 *  there is no action to offer. */
export const GUEST_VOTE_CAST_ELSEWHERE_MESSAGE =
	"This vote was already cast from another device.";

/**
 * The fallback when storage is unavailable (a private window, blocked site
 * data): one token for the page's lifetime, so a voter who mis-taps can still
 * correct themselves before they reload.
 */
let pageLifetimeToken: string | null = null;

function pageToken(): string {
	pageLifetimeToken ??= crypto.randomUUID();
	return pageLifetimeToken;
}

/**
 * This browser's ballot device token: read from localStorage, minted with
 * `crypto.randomUUID()` on first use. If storage throws, a module-level token
 * that lasts as long as the page does.
 *
 * A stored value that is not a UUID is replaced rather than sent, because the
 * server validates it as one and would refuse the whole cast.
 */
export function getBallotDeviceToken(): string {
	try {
		const stored = window.localStorage.getItem(BALLOT_DEVICE_KEY);
		if (stored && UUID.test(stored)) return stored;
		const minted = crypto.randomUUID();
		window.localStorage.setItem(BALLOT_DEVICE_KEY, minted);
		return minted;
	} catch {
		return pageToken();
	}
}

/** The shape zod's `.uuid()` accepts on the server (RFC 9562 version and
 *  variant bits), so a value that passes here is never refused there. */
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

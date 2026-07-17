// Signed, no-auth unsubscribe tokens (#274 — the reminders control layer).
//
// Every reminder email carries a one-click unsubscribe link that flips the
// recipient's opt-out preference WITHOUT a sign-in. The link must therefore be
// unforgeable: a bare `?personId=<uuid>` would let anyone unsubscribe anyone.
// So we bind the personId to an HMAC-SHA256 signature keyed by
// `BETTER_AUTH_SECRET` (the same server secret Better-Auth signs sessions with)
// — reproducible on the server, but not forgeable by a recipient who never sees
// the key.
//
// Token shape: `<personId>.<base64url(hmac)>`. Stateless (no DB row to store or
// expire) and idempotent to redeem. `node:crypto` makes this a SERVER-ONLY
// module: only the role-reminder producer (#272, building links) and the
// `/unsubscribe` route (verifying) import it — never a client component.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Fallback base URL for the unsubscribe link when `BETTER_AUTH_URL` is unset
 *  (it is always set in dev/prod; this only keeps an email link absolute in a
 *  bare env rather than emitting a useless relative URL). */
const FALLBACK_BASE_URL = "https://gavelup.app";

function secret(): string {
	const value = process.env.BETTER_AUTH_SECRET;
	if (!value) {
		throw new Error(
			"BETTER_AUTH_SECRET is required to sign unsubscribe tokens.",
		);
	}
	return value;
}

/** HMAC-SHA256 of the personId, base64url-encoded. */
function sign(personId: string): string {
	return createHmac("sha256", secret()).update(personId).digest("base64url");
}

/** Mint an unsubscribe token binding `personId` to its HMAC signature. */
export function createUnsubscribeToken(personId: string): string {
	return `${personId}.${sign(personId)}`;
}

/**
 * Verify a token and return the personId it authorizes, or null when the token
 * is malformed or the signature doesn't match (forged / tampered / wrong key).
 * Constant-time signature comparison avoids a timing side channel.
 */
export function verifyUnsubscribeToken(token: string): string | null {
	// Split on the LAST dot: a personId is a UUID (no dots), but be defensive.
	const dot = token.lastIndexOf(".");
	if (dot <= 0 || dot === token.length - 1) return null;
	const personId = token.slice(0, dot);
	const providedSig = token.slice(dot + 1);

	const expected = Buffer.from(sign(personId));
	const provided = Buffer.from(providedSig);
	// timingSafeEqual throws on length mismatch — guard first.
	if (expected.length !== provided.length) return null;
	if (!timingSafeEqual(expected, provided)) return null;
	return personId;
}

/** The app base URL (no trailing slash) for building absolute email links. */
export function appBaseUrl(): string {
	const raw = process.env.BETTER_AUTH_URL || FALLBACK_BASE_URL;
	return raw.replace(/\/+$/, "");
}

/** Build the absolute one-click unsubscribe URL for a person's reminder emails. */
export function buildUnsubscribeUrl(personId: string): string {
	const token = createUnsubscribeToken(personId);
	return `${appBaseUrl()}/unsubscribe?token=${encodeURIComponent(token)}`;
}

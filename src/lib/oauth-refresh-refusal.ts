/**
 * Recognise the refusal migration 0087's trigger raises when something tries
 * to mint a refresh token for a user with no consent for that client (#851).
 *
 * The trigger is what makes Disconnect final, and the provider does not know it
 * exists: it sees a failed INSERT, and Better Auth answers any non-API error
 * with an empty HTTP 500. A client told "server error" retries; a client told
 * `invalid_grant` knows its grant is gone and asks the person to reconnect. So
 * `auth.ts` maps exactly this error, and only this one, to `invalid_grant`.
 *
 * Matched on BOTH the SQLSTATE and the message prefix. The code alone is
 * `insufficient_privilege`, which a misconfigured database role would also
 * raise, and turning that into "your grant is gone" would hide an outage.
 */

/** The prefix of the trigger's `RAISE EXCEPTION` text. Keep in step with 0087. */
export const REFRESH_REFUSAL_MESSAGE = "oauth_refresh_token refused: user ";

/** Postgres's SQLSTATE for `insufficient_privilege`, which the trigger uses. */
export const REFRESH_REFUSAL_SQLSTATE = "42501";

/**
 * True when `error`, or anything on its `cause` chain, is the trigger's
 * refusal. The pg error arrives wrapped (Drizzle's query error, the adapter's),
 * so the chain is walked, to a fixed depth in case of a cycle.
 */
export function isRefreshRefusal(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current; depth++) {
		if (typeof current !== "object") return false;
		const { code, message, cause } = current as {
			code?: unknown;
			message?: unknown;
			cause?: unknown;
		};
		if (
			code === REFRESH_REFUSAL_SQLSTATE &&
			typeof message === "string" &&
			message.startsWith(REFRESH_REFUSAL_MESSAGE)
		) {
			return true;
		}
		current = cause;
	}
	return false;
}

/**
 * What `/oauth/consent` shows about the app asking to connect (#843).
 *
 * The client's NAME comes from here, server-side, by id — never from the query
 * string. A consent screen that rendered a name straight from its own URL
 * would let anyone mint a link reading "GavelUp Official Sync" for a client
 * that is nothing of the kind. The `client_id` in the query is part of the
 * provider's signed payload, so the lookup names the client the provider will
 * actually issue a code to.
 */
import { auth } from "#/lib/auth";

export type ConsentClientLookup =
	| { signedIn: false }
	| {
			signedIn: true;
			/**
			 * Who is approving. The id goes back with the decision
			 * (`#/lib/oauth-consent-binding`), so Approve cannot connect an
			 * account other than the one this screen named.
			 */
			userId: string;
			/** Shown so a cross-device sign-in names the account. */
			email: string;
			/** Null when the provider could not identify the client. */
			client: { clientId: string; name: string | null } | null;
	  };

/**
 * Resolve the signed-in person and the requesting client for a consent screen.
 *
 * `getOAuthClientPublic` requires a session, which is why the session is read
 * first: signed-out is its own answer (the page bounces to `/signin`), not a
 * failed lookup. Any lookup failure — unknown client, disabled client, a
 * provider error — degrades to `client: null`, and the page then shows the raw
 * id and says it could not identify the app. It never throws, because a
 * consent screen that errors hides the one decision the person came to make.
 */
export async function lookupConsentClient(
	headers: Headers,
	clientId: string,
): Promise<ConsentClientLookup> {
	const session = await auth.api.getSession({ headers });
	if (!session) return { signedIn: false };
	try {
		const client = await auth.api.getOAuthClientPublic({
			query: { client_id: clientId },
			headers,
		});
		return {
			signedIn: true,
			userId: session.user.id,
			email: session.user.email,
			client: {
				clientId: client.client_id,
				name: client.client_name ?? null,
			},
		};
	} catch (err) {
		console.error("[oauth] consent could not identify client:", err);
		return {
			signedIn: true,
			userId: session.user.id,
			email: session.user.email,
			client: null,
		};
	}
}

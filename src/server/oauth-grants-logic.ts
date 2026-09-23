/**
 * The OAuth grants a person has given (#851): what `/me`'s "Connected apps"
 * section lists, and what its Disconnect button ends.
 *
 * Kept in a `-logic.ts` so `#/db` never leaks into the client bundle
 * (server-modules guard); the server fns are in `oauth-grants.ts`.
 *
 * A grant is three things in the provider's tables, and disconnecting has to
 * end all of them. `oauth_consent` is what lets a later authorize skip the
 * consent screen. `oauth_refresh_token` is what lets the app keep minting
 * access tokens for 30 days without anyone looking. And an authorization code
 * the app holds but has not redeemed yet (a `verification` row) mints a fresh
 * refresh token when it is redeemed, because the provider never re-checks
 * consent at redemption. Better Auth's own `/oauth2/delete-consent` deletes only
 * the first, so an app it "disconnected" keeps refreshing for a month — which is
 * why this does not call it.
 *
 * Every statement is scoped by the caller's user id. Clients are SHARED: every
 * person who connects claude.ai holds the same `client_id`, so a client id on
 * its own names everyone's grant at once. A caller can only ever touch their
 * own rows for a client, whatever client id they send.
 */
import { and, desc, eq, gt, isNull, max, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	oauthClient,
	oauthConsent,
	oauthRefreshToken,
	verification,
} from "#/db/schema";

export interface ConnectedApp {
	clientId: string;
	/** oauth_client.name, or null when the client row has none. */
	name: string | null;
	/**
	 * oauth_consent.created_at, or null when the app holds live refresh tokens
	 * with no consent on file (see `listConnectedApps`).
	 */
	approvedAt: Date | null;
	/**
	 * Newest oauth_refresh_token.created_at for this user × client, revoked or
	 * not, or null. A row is written on every rotation, so this is "last
	 * renewed" — within an hour of real use while the app is active. The UI
	 * labels it "Last active"; it is not a per-call timestamp.
	 */
	lastActiveAt: Date | null;
}

export interface DisconnectResult {
	consentsDeleted: number;
	refreshTokensDeleted: number;
	codesDeleted: number;
}

/**
 * Every app the user has granted access to, newest approval first: one row per
 * `oauth_consent`, then one per client for which the user still holds a LIVE
 * refresh token but no consent.
 *
 * The second half is the repair path. The trigger in migration 0087 stops new
 * orphans being minted, but it cannot remove the ones that already exist:
 * tokens from before it, a client registered with `skip_consent`, or Better
 * Auth's own `/oauth2/delete-consent`, which is still routed and deletes only
 * the consent. A list built from consents alone would hide exactly the grant
 * the person most needs to see, with no way to disconnect it.
 */
export async function listConnectedApps(
	userId: string,
	database: typeof db = db,
): Promise<ConnectedApp[]> {
	// LEFT JOINs rather than correlated subqueries: a join condition keeps both
	// the user and the client qualifier, where a hand-written subquery can lose
	// one and match every user's tokens for the client.
	const consented = await database
		.select({
			clientId: oauthConsent.clientId,
			name: oauthClient.name,
			approvedAt: oauthConsent.createdAt,
			lastActiveAt: max(oauthRefreshToken.createdAt),
		})
		.from(oauthConsent)
		.innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
		.leftJoin(
			oauthRefreshToken,
			and(
				eq(oauthRefreshToken.clientId, oauthConsent.clientId),
				eq(oauthRefreshToken.userId, oauthConsent.userId),
			),
		)
		.where(eq(oauthConsent.userId, userId))
		.groupBy(oauthConsent.id, oauthClient.name)
		.orderBy(desc(oauthConsent.createdAt));

	const orphaned = await database
		.select({
			clientId: oauthRefreshToken.clientId,
			name: oauthClient.name,
			lastActiveAt: max(oauthRefreshToken.createdAt),
		})
		.from(oauthRefreshToken)
		.innerJoin(
			oauthClient,
			eq(oauthClient.clientId, oauthRefreshToken.clientId),
		)
		.leftJoin(
			oauthConsent,
			and(
				eq(oauthConsent.clientId, oauthRefreshToken.clientId),
				eq(oauthConsent.userId, oauthRefreshToken.userId),
			),
		)
		.where(
			and(
				eq(oauthRefreshToken.userId, userId),
				isNull(oauthRefreshToken.revoked),
				gt(oauthRefreshToken.expiresAt, new Date()),
				isNull(oauthConsent.id),
			),
		)
		.groupBy(oauthRefreshToken.clientId, oauthClient.name);

	return [
		...consented.map((r) => ({
			clientId: r.clientId,
			name: r.name ?? null,
			approvedAt: r.approvedAt ?? null,
			lastActiveAt: r.lastActiveAt ?? null,
		})),
		...orphaned.map((r) => ({
			clientId: r.clientId,
			name: r.name ?? null,
			approvedAt: null,
			lastActiveAt: r.lastActiveAt ?? null,
		})),
	];
}

/**
 * End `userId`'s grant to `clientId`. One transaction, in this order:
 *
 *   1. lock the consent row (`FOR UPDATE`);
 *   2. delete every refresh token — which cascades to the access-token rows
 *      that reference them;
 *   3. delete every authorization code issued but not yet redeemed;
 *   4. delete the consent.
 *
 * The lock is what makes this exact rather than nearly right. Migration 0087's
 * trigger refuses any new refresh token without a consent and takes a SHARE
 * lock on that consent to check it. So a mint racing this transaction either
 * committed before step 1 was granted — and step 2 sees its row — or waits on
 * step 1 and is refused once the consent is gone. That covers both ways an app
 * used to survive a disconnect: a rotation that revoked its old token first and
 * inserted the new one after, and a code redeemed after step 3 had missed it.
 *
 * Refresh tokens are DELETED, not marked revoked. The provider treats a revoked
 * token presented again as token theft and deletes the whole user × client
 * family — so a stale retry of a disconnected token, arriving after the person
 * reconnected, would wipe out their NEW connection. A deleted token is simply
 * unknown ("invalid_grant").
 *
 * What is not ended here: an access token already issued. They are JWTs checked
 * without a revocation lookup (ADR-0027), so one keeps working until it
 * expires, within the hour.
 *
 * An unknown client id, or one this user holds no grant for, returns zeros.
 */
export async function disconnectApp(
	userId: string,
	clientId: string,
	database: typeof db = db,
): Promise<DisconnectResult> {
	return database.transaction(async (tx) => {
		const ownConsent = and(
			eq(oauthConsent.userId, userId),
			eq(oauthConsent.clientId, clientId),
		);
		await tx
			.select({ id: oauthConsent.id })
			.from(oauthConsent)
			.where(ownConsent)
			.for("update");

		const tokens = await tx
			.delete(oauthRefreshToken)
			.where(
				and(
					eq(oauthRefreshToken.userId, userId),
					eq(oauthRefreshToken.clientId, clientId),
				),
			)
			.returning({ id: oauthRefreshToken.id });

		// The provider stores a code's grant as `JSON.stringify({ type, query,
		// userId, ... })`. The CASE keeps the jsonb cast off every other kind of
		// verification row, magic-link tokens among them, which need not be JSON.
		const codes = await tx
			.delete(verification)
			.where(
				sql`case when ${verification.value} like '{"type":"authorization_code",%'
					then (${verification.value}::jsonb ->> 'userId') = ${userId}
						and (${verification.value}::jsonb -> 'query' ->> 'client_id') = ${clientId}
					else false end`,
			)
			.returning({ id: verification.id });

		const consents = await tx
			.delete(oauthConsent)
			.where(ownConsent)
			.returning({ id: oauthConsent.id });

		return {
			consentsDeleted: consents.length,
			refreshTokensDeleted: tokens.length,
			codesDeleted: codes.length,
		};
	});
}

/**
 * The OAuth grants a person has given (#851): what `/me`'s "Connected apps"
 * section lists, and what its Disconnect button revokes.
 *
 * Kept in a `-logic.ts` so `#/db` never leaks into the client bundle
 * (server-modules guard); the server fns are in `oauth-grants.ts`.
 *
 * A grant is two things in the provider's tables, and disconnecting has to end
 * BOTH. `oauth_consent` is what lets a later authorize skip the consent screen;
 * `oauth_refresh_token` is what lets the app keep minting access tokens for 30
 * days without anyone looking. Better Auth's own `/oauth2/delete-consent`
 * deletes only the first, so an app it "disconnected" keeps refreshing for a
 * month — which is why this does not call it.
 *
 * Every statement is scoped by the caller's user id. Clients are SHARED: every
 * person who connects claude.ai holds the same `client_id`, so a client id on
 * its own names everyone's grant at once. A caller can only ever touch their
 * own rows for a client, whatever client id they send.
 */
import { and, desc, eq, isNull, max } from "drizzle-orm";
import { db } from "#/db";
import { oauthClient, oauthConsent, oauthRefreshToken } from "#/db/schema";

export interface ConnectedApp {
	clientId: string;
	/** oauth_client.name, or null when the client row has none. */
	name: string | null;
	/**
	 * oauth_consent.created_at. Nullable only because the column is; the
	 * provider writes it on every consent.
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

/** One row per `oauth_consent` of `userId`, newest approval first. */
export async function listConnectedApps(
	userId: string,
	database: typeof db = db,
): Promise<ConnectedApp[]> {
	// A LEFT JOIN + GROUP BY rather than a correlated subquery: the refresh
	// tokens are matched on the consent's own user AND client, and a join
	// condition keeps both qualifiers where a hand-written subquery can lose one
	// and match every user's tokens for the client.
	const rows = await database
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
	return rows.map((r) => ({
		clientId: r.clientId,
		name: r.name ?? null,
		approvedAt: r.approvedAt ?? null,
		lastActiveAt: r.lastActiveAt ?? null,
	}));
}

/**
 * End `userId`'s grant to `clientId`: revoke every live refresh token, delete
 * the consent. One transaction, three statements, in this order.
 *
 * The second revoke is not a typo. A refresh racing the disconnect reads the
 * old token, and rotation writes a NEW unrevoked row. If that commits after
 * statement 1 but before statement 3, statement 3 catches it — each statement
 * under READ COMMITTED sees whatever committed before it started. A rotation
 * committing after this whole transaction can still leave one token alive.
 * That window is milliseconds, and what it buys is bounded by the same
 * one-hour expiry as any access token already issued (ADR-0027: access tokens
 * are verified locally with no revocation lookup). No lock is taken for it.
 *
 * An unknown client id, or one this user holds no grant for, returns zeros.
 */
export async function disconnectApp(
	userId: string,
	clientId: string,
	database: typeof db = db,
): Promise<{ consentsDeleted: number; refreshTokensRevoked: number }> {
	return database.transaction(async (tx) => {
		const revokeLive = () =>
			tx
				.update(oauthRefreshToken)
				.set({ revoked: new Date() })
				.where(
					and(
						eq(oauthRefreshToken.userId, userId),
						eq(oauthRefreshToken.clientId, clientId),
						isNull(oauthRefreshToken.revoked),
					),
				)
				.returning({ id: oauthRefreshToken.id });

		const first = await revokeLive();
		const consents = await tx
			.delete(oauthConsent)
			.where(
				and(
					eq(oauthConsent.userId, userId),
					eq(oauthConsent.clientId, clientId),
				),
			)
			.returning({ id: oauthConsent.id });
		const second = await revokeLive();

		return {
			consentsDeleted: consents.length,
			refreshTokensRevoked: first.length + second.length,
		};
	});
}

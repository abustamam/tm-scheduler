/**
 * Connected apps on `/me` (#851): listing a person's OAuth grants and
 * disconnecting one, against grants made by the REAL `auth.handler`.
 *
 * Every grant here is minted through `#/test/oauth-flow` — authorize, consent,
 * token — rather than inserted. The claim under test is that the provider
 * stops honouring a grant after `disconnectApp`, and only the provider can
 * answer that: a test that read `revoked` back off the table would pass
 * whatever the provider actually checks.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/oauth-grants-logic.integration.test.ts
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const oauth = await import("#/test/oauth-flow");
const { disconnectApp, listConnectedApps } = await import(
	"./oauth-grants-logic"
);

type Loaded = Awaited<ReturnType<typeof oauth.loadAuthForTest>>;
type Client = Awaited<ReturnType<typeof oauth.registerClient>>;

/**
 * `testDb` whose transactions run `before` just ahead of statement 2 of
 * `disconnectApp`, the consent delete. `before` may throw (the atomicity test)
 * or commit a row on another connection (the race test). The pattern of
 * `register-oauth-client.integration.test.ts`, one level down, because the
 * statements run on the tx and not on the db. It follows the chain
 * `disconnectApp` builds, `delete().where().returning()`, so `before` runs
 * when the statement is sent rather than when it is constructed.
 */
function beforeConsentDelete(before: () => Promise<void>): typeof testDb {
	type Chain = {
		where: (w: unknown) => { returning: (f: unknown) => Promise<unknown> };
	};
	return new Proxy(testDb, {
		get: (target, prop, receiver) =>
			prop === "transaction"
				? (cb: (tx: unknown) => Promise<unknown>) =>
						target.transaction((tx) =>
							cb(
								new Proxy(tx, {
									get: (t, p, r) =>
										p === "delete"
											? (table: unknown) => ({
													where: (w: unknown) => ({
														returning: async (f: unknown) => {
															await before();
															const real = (
																t.delete as unknown as (x: unknown) => Chain
															)(table);
															return real.where(w).returning(f);
														},
													}),
												})
											: Reflect.get(t, p, r),
								}),
							),
						)
				: Reflect.get(target, prop, receiver),
	});
}

/** A timestamp column as epoch ms, read as Drizzle maps it (as UTC). */
const epochMs = (column: string) =>
	sql.raw(`(extract(epoch from ${column}) * 1000)::float8`);

describe.skipIf(!hasTestDb)(
	"connected apps: list and disconnect (#851)",
	() => {
		const SUFFIX = randomBytes(4).toString("hex");
		const SUPERADMIN = `grants-admin-${SUFFIX}@example.com`;
		const emails = new Set<string>([SUPERADMIN]);
		let emailCount = 0;
		const clients: Client[] = [];
		let loaded: Loaded;
		let superCookie: string;

		/** A never-seen user, signed in for real. */
		async function freshUser(): Promise<{ id: string; cookie: string }> {
			const email = `grants-user-${SUFFIX}-${emailCount++}@example.com`;
			emails.add(email);
			const cookie = await oauth.signInCookie(loaded, email);
			return { id: await oauth.sessionUserId(loaded, cookie), cookie };
		}

		async function freshClient(label: string): Promise<Client> {
			const client = await oauth.registerClient(
				loaded,
				superCookie,
				`grants ${label} ${SUFFIX}`,
			);
			clients.push(client);
			return client;
		}

		/** A real grant carrying a refresh token. */
		async function grantWithRefresh(
			client: Client,
			cookie: string,
		): Promise<string> {
			const tokens = await oauth.mintGrant(loaded, client, cookie, {
				scope: "offline_access",
			});
			if (!tokens.refresh_token)
				throw new Error("grant issued no refresh token");
			return tokens.refresh_token;
		}

		/** Every row a user holds for a client, as text, for byte-for-byte compare. */
		async function snapshot(userId: string, clientId: string) {
			const refresh = await testDb.execute<{ row: string }>(
				sql`select t::text as row from oauth_refresh_token t where t.user_id = ${userId} and t.client_id = ${clientId} order by t.id`,
			);
			const consent = await testDb.execute<{ row: string }>(
				sql`select c::text as row from oauth_consent c where c.user_id = ${userId} and c.client_id = ${clientId} order by c.id`,
			);
			return {
				refresh: refresh.rows.map((r) => r.row),
				consent: consent.rows.map((r) => r.row),
			};
		}

		async function liveRefreshCount(
			userId: string,
			clientId: string,
		): Promise<number> {
			const rows = await testDb.execute<{ n: string }>(
				sql`select count(*)::text as n from oauth_refresh_token where user_id = ${userId} and client_id = ${clientId} and revoked is null`,
			);
			return Number(rows.rows[0]?.n ?? "-1");
		}

		beforeAll(async () => {
			loaded = await oauth.loadAuthForTest(SUPERADMIN);
			superCookie = await oauth.signInCookie(loaded, SUPERADMIN);
		});

		afterAll(async () => {
			await oauth.cleanupOAuth(
				clients.map((c) => c.clientId),
				[...emails],
			);
			loaded.restoreEnv();
		});

		describe("listConnectedApps", () => {
			it("lists the caller's own grants only, newest approval first", async () => {
				const older = await freshClient("older");
				const newer = await freshClient("newer");
				const x = await freshUser();
				const y = await freshUser();
				await oauth.mintAccessToken(loaded, older, y.cookie);
				await oauth.mintAccessToken(loaded, newer, y.cookie);
				await oauth.mintAccessToken(loaded, older, x.cookie);
				// The provider stamps consents to the second, so grants in one test
				// tie. Age one so the order is the ORDER BY's, not a tie-break's.
				await testDb.execute(
					sql`update oauth_consent set created_at = created_at - interval '1 hour' where user_id = ${y.id} and client_id = ${older.clientId}`,
				);

				const ys = await listConnectedApps(y.id);
				expect(ys.map((a) => a.clientId)).toEqual([
					newer.clientId,
					older.clientId,
				]);
				// X shares a client with Y and still sees exactly one row: their own.
				const xs = await listConnectedApps(x.id);
				expect(xs.map((a) => a.clientId)).toEqual([older.clientId]);
			});

			it("carries the client's name and the consent's approval date", async () => {
				const client = await freshClient("named");
				const x = await freshUser();
				const before = Date.now();
				await oauth.mintAccessToken(loaded, client, x.cookie);
				const [app] = await listConnectedApps(x.id);
				expect(app?.name).toBe(`grants named ${SUFFIX}`);
				expect(app?.approvedAt).toBeInstanceOf(Date);
				const [stored] = (
					await testDb.execute<{ ms: number }>(
						sql`select ${epochMs("created_at")} as ms from oauth_consent where user_id = ${x.id} and client_id = ${client.clientId}`,
					)
				).rows;
				expect(app?.approvedAt?.getTime()).toBe(stored?.ms);
				expect(app?.approvedAt?.getTime()).toBeGreaterThan(before - 60_000);
			});

			it("lastActiveAt is null with no refresh token, else the NEWEST one's creation", async () => {
				const client = await freshClient("active");
				const x = await freshUser();
				// No offline_access: an access token and no refresh token. The scope
				// is named because with none at all the provider grants every scope,
				// offline_access included.
				const plain = await oauth.mintGrant(loaded, client, x.cookie, {
					scope: "email",
				});
				expect(plain.refresh_token).toBeUndefined();
				// Another user's refresh token for the SAME client is not X's activity.
				const y = await freshUser();
				await grantWithRefresh(client, y.cookie);
				expect((await listConnectedApps(x.id))[0]?.lastActiveAt).toBeNull();

				const refresh = await grantWithRefresh(client, x.cookie);
				const renewed = await oauth.refreshGrant(loaded, client, refresh);
				expect(renewed.status).toBe(200);

				// Age the rotated-out row so "newest" is not decided by a same-second tie.
				await testDb.execute(
					sql`update oauth_refresh_token set created_at = created_at - interval '1 hour' where user_id = ${x.id} and client_id = ${client.clientId} and revoked is not null`,
				);
				const [newest] = (
					await testDb.execute<{ ms: number; n: string }>(
						sql`select ${epochMs("created_at")} as ms, (select count(*)::text from oauth_refresh_token where user_id = ${x.id} and client_id = ${client.clientId}) as n from oauth_refresh_token where user_id = ${x.id} and client_id = ${client.clientId} and revoked is null`,
					)
				).rows;
				expect(newest?.n).toBe("2");
				const [app] = await listConnectedApps(x.id);
				expect(app?.lastActiveAt?.getTime()).toBe(newest?.ms);
				// Two refresh rows exist (the grant's and its rotation), one app row.
				expect(await listConnectedApps(x.id)).toHaveLength(1);
			});
		});

		describe("disconnectApp", () => {
			it("revokes every live refresh token AND deletes the consent", async () => {
				const client = await freshClient("disconnect");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);
				await grantWithRefresh(client, x.cookie);
				expect(await liveRefreshCount(x.id, client.clientId)).toBe(2);

				const result = await disconnectApp(x.id, client.clientId);
				expect(result).toEqual({ consentsDeleted: 1, refreshTokensRevoked: 2 });
				expect(await liveRefreshCount(x.id, client.clientId)).toBe(0);
				expect((await snapshot(x.id, client.clientId)).consent).toEqual([]);
				expect(await listConnectedApps(x.id)).toEqual([]);
			});

			it("touches only the caller's rows when another user holds the same client", async () => {
				const client = await freshClient("shared");
				const x = await freshUser();
				const y = await freshUser();
				await grantWithRefresh(client, x.cookie);
				await grantWithRefresh(client, y.cookie);
				const yBefore = await snapshot(y.id, client.clientId);
				expect(yBefore.refresh).toHaveLength(1);
				expect(yBefore.consent).toHaveLength(1);

				const result = await disconnectApp(x.id, client.clientId);
				expect(result).toEqual({ consentsDeleted: 1, refreshTokensRevoked: 1 });
				expect(await snapshot(y.id, client.clientId)).toEqual(yBefore);
			});

			it("returns zeros for an unknown client, or one the caller holds no grant for", async () => {
				const client = await freshClient("not-mine");
				const x = await freshUser();
				const y = await freshUser();
				await grantWithRefresh(client, y.cookie);
				const yBefore = await snapshot(y.id, client.clientId);

				expect(await disconnectApp(x.id, `no-such-client-${SUFFIX}`)).toEqual({
					consentsDeleted: 0,
					refreshTokensRevoked: 0,
				});
				expect(await disconnectApp(x.id, client.clientId)).toEqual({
					consentsDeleted: 0,
					refreshTokensRevoked: 0,
				});
				expect(await snapshot(y.id, client.clientId)).toEqual(yBefore);
			});

			it("is atomic: a failing consent delete rolls the revocations back", async () => {
				const client = await freshClient("atomic");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);
				const before = await snapshot(x.id, client.clientId);

				const failing = beforeConsentDelete(async () => {
					throw new Error("delete failed");
				});
				await expect(
					disconnectApp(x.id, client.clientId, failing),
				).rejects.toThrow("delete failed");
				expect(await snapshot(x.id, client.clientId)).toEqual(before);
				expect(await liveRefreshCount(x.id, client.clientId)).toBe(1);
			});

			it("catches a rotation that commits between the first revoke and the last", async () => {
				const client = await freshClient("race");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);

				// Stand in for a refresh that read the old token before statement 1 and
				// commits its NEW row while the disconnect is still open: inserted on a
				// separate connection, so it is committed before statement 3 starts.
				const racingId = `racing-${SUFFIX}`;
				const racing = beforeConsentDelete(async () => {
					await testDb.execute(
						sql`insert into oauth_refresh_token (id, token, client_id, user_id, scopes, created_at, expires_at)
						values (${racingId}, ${`tok-${racingId}`}, ${client.clientId}, ${x.id}, array['offline_access'], now(), now() + interval '30 days')`,
					);
				});
				const result = await disconnectApp(x.id, client.clientId, racing);
				expect(result).toEqual({ consentsDeleted: 1, refreshTokensRevoked: 2 });
				expect(await liveRefreshCount(x.id, client.clientId)).toBe(0);
			});
		});

		describe("against the provider", () => {
			it("a refresh token stops working: the token endpoint answers invalid_grant", async () => {
				const client = await freshClient("refresh-dead");
				const x = await freshUser();
				const first = await grantWithRefresh(client, x.cookie);
				// Control: the grant is live, and renewing rotates it.
				const renewed = await oauth.refreshGrant(loaded, client, first);
				expect(renewed.status).toBe(200);
				const { refresh_token: current } = (await renewed.json()) as {
					refresh_token: string;
				};
				expect(current).toBeTruthy();

				await disconnectApp(x.id, client.clientId);

				const after = await oauth.refreshGrant(loaded, client, current);
				expect(after.status).toBe(400);
				expect(((await after.json()) as { error: string }).error).toBe(
					"invalid_grant",
				);
			});

			it("a new authorize shows the consent screen again instead of issuing a code", async () => {
				const client = await freshClient("reconsent");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);
				// Control: with consent on file, authorize goes straight to the client.
				const silent = await oauth.startAuthorize(loaded, client, x.cookie, {
					scope: "offline_access",
				});
				expect(silent.location.href.startsWith(oauth.TEST_REDIRECT_URI)).toBe(
					true,
				);

				await disconnectApp(x.id, client.clientId);

				const again = await oauth.startAuthorize(loaded, client, x.cookie, {
					scope: "offline_access",
				});
				expect(again.location.pathname).toBe("/oauth/consent");
				expect(again.location.searchParams.get("code")).toBeNull();
			});
		});
	},
);

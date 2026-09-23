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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { oauthConsent } from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const oauth = await import("#/test/oauth-flow");
const { disconnectApp, listConnectedApps } = await import(
	"./oauth-grants-logic"
);

type Loaded = Awaited<ReturnType<typeof oauth.loadAuthForTest>>;
type Client = Awaited<ReturnType<typeof oauth.registerClient>>;

/**
 * `testDb` whose transactions run `before` just ahead of `disconnectApp`'s
 * LAST statement, the consent delete — after the lock is held and the tokens
 * and codes are gone. `before` may throw (the atomicity test) or start a mint
 * on another connection (the race test). The pattern of
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
											? (table: unknown) => {
													const real = (
														t.delete as unknown as (x: unknown) => Chain
													)(table);
													if (table !== oauthConsent) return real;
													return {
														where: (w: unknown) => ({
															returning: async (f: unknown) => {
																await before();
																return real.where(w).returning(f);
															},
														}),
													};
												}
											: Reflect.get(t, p, r),
								}),
							),
						)
				: Reflect.get(target, prop, receiver),
	});
}

const TRIGGER_MIGRATION = readFileSync(
	resolve(__dirname, "../../drizzle/0087_oauth_refresh_requires_consent.sql"),
	"utf8",
);

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

		/**
		 * A real grant carrying a refresh token. The consent covers `email` too,
		 * so a later `email`-only authorize issues a code silently — one that
		 * mints no refresh token on redemption (`pendingCode`).
		 */
		async function grantWithRefresh(
			client: Client,
			cookie: string,
		): Promise<string> {
			const tokens = await oauth.mintGrant(loaded, client, cookie, {
				scope: "email offline_access",
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
			const codes = await testDb.execute<{ row: string }>(
				sql`select v::text as row from verification v where ${pendingCodeOf(userId, clientId)} order by v.id`,
			);
			return {
				refresh: refresh.rows.map((r) => r.row),
				consent: consent.rows.map((r) => r.row),
				codes: codes.rows.map((r) => r.row),
			};
		}

		/**
		 * The provider's pending authorization codes for a user × client. Text
		 * matching, not a jsonb cast: the NUL-state regression below plants a row
		 * Postgres cannot parse, and a cast here would make every snapshot throw.
		 */
		function pendingCodeOf(userId: string, clientId: string) {
			return sql`value like '{"type":"authorization_code",%'
				and value like ${`%"userId":"${userId}"%`}
				and value like ${`%"client_id":"${clientId}"%`}`;
		}

		async function refreshCount(
			userId: string,
			clientId: string,
		): Promise<number> {
			const rows = await testDb.execute<{ n: string }>(
				sql`select count(*)::text as n from oauth_refresh_token where user_id = ${userId} and client_id = ${clientId}`,
			);
			return Number(rows.rows[0]?.n ?? "-1");
		}

		/**
		 * An authorization code for a user who has ALREADY consented, issued and
		 * not redeemed — what an app holds between the redirect and its token call.
		 */
		async function pendingCode(
			client: Client,
			cookie: string,
			scope: string,
		): Promise<{ code: string; verifier: string }> {
			const { location, verifier } = await oauth.startAuthorize(
				loaded,
				client,
				cookie,
				{ scope },
			);
			const code = location.searchParams.get("code");
			if (!code) throw new Error(`authorize issued no code: ${location.href}`);
			return { code, verifier };
		}

		/** The text of a failed query, including Postgres's own message. */
		function errorText(e: unknown): string {
			const err = e as { message?: string; cause?: { message?: string } };
			return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
		}

		async function insertRawRefresh(
			id: string,
			clientId: string,
			userId: string,
		) {
			// The id leads the statement as a comment so `pg_stat_activity.query`,
			// which shows bind placeholders rather than values, can name it.
			return testDb.execute(
				sql`${sql.raw(`/* ${id.replace(/[^a-z0-9-]/gi, "")} */`)} insert into oauth_refresh_token (id, token, client_id, user_id, scopes, created_at, expires_at)
					values (${id}, ${`tok-${id}`}, ${clientId}, ${userId}, array['offline_access'], now(), now() + interval '30 days')`,
			);
		}

		beforeAll(async () => {
			// `tm_test` is push-synced locally, and `db:push` cannot see a trigger
			// (CI migrates it, so there it is already present). Applying the
			// migration's own SQL, which is idempotent, means this suite proves
			// the file that ships rather than a copy of it.
			for (const statement of TRIGGER_MIGRATION.split(
				"--> statement-breakpoint",
			)) {
				await testDb.execute(sql.raw(statement));
			}
			loaded = await oauth.loadAuthForTest(SUPERADMIN);
			superCookie = await oauth.signInCookie(loaded, SUPERADMIN);
		});

		afterAll(async () => {
			// Pending codes are keyed by a hashed code, not an email, so
			// `cleanupOAuth` cannot find them. Scoped to this run's clients.
			for (const c of clients) {
				await testDb.execute(
					sql`delete from verification where value like '{"type":"authorization_code",%' and value like ${`%"client_id":"${c.clientId}"%`}`,
				);
			}
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
			it("deletes every refresh token, every pending code AND the consent", async () => {
				const client = await freshClient("disconnect");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);
				await grantWithRefresh(client, x.cookie);
				await pendingCode(client, x.cookie, "email");
				const before = await snapshot(x.id, client.clientId);
				expect(before.refresh).toHaveLength(2);
				expect(before.codes).toHaveLength(1);

				const result = await disconnectApp(x.id, client.clientId);
				expect(result).toEqual({
					consentsDeleted: 1,
					refreshTokensDeleted: 2,
					codesDeleted: 1,
				});
				expect(await snapshot(x.id, client.clientId)).toEqual({
					refresh: [],
					consent: [],
					codes: [],
				});
				expect(await listConnectedApps(x.id)).toEqual([]);
			});

			it("touches only the caller's rows when another user holds the same client", async () => {
				const client = await freshClient("shared");
				const x = await freshUser();
				const y = await freshUser();
				await grantWithRefresh(client, x.cookie);
				await grantWithRefresh(client, y.cookie);
				await pendingCode(client, x.cookie, "email");
				await pendingCode(client, y.cookie, "email");
				const yBefore = await snapshot(y.id, client.clientId);
				expect(yBefore.refresh).toHaveLength(1);
				expect(yBefore.consent).toHaveLength(1);
				expect(yBefore.codes).toHaveLength(1);

				const result = await disconnectApp(x.id, client.clientId);
				expect(result).toEqual({
					consentsDeleted: 1,
					refreshTokensDeleted: 1,
					codesDeleted: 1,
				});
				expect(await snapshot(y.id, client.clientId)).toEqual(yBefore);
			});

			it("returns zeros for an unknown client, or one the caller holds no grant for", async () => {
				const client = await freshClient("not-mine");
				const x = await freshUser();
				const y = await freshUser();
				await grantWithRefresh(client, y.cookie);
				await pendingCode(client, y.cookie, "email");
				const yBefore = await snapshot(y.id, client.clientId);
				const zeros = {
					consentsDeleted: 0,
					refreshTokensDeleted: 0,
					codesDeleted: 0,
				};

				expect(await disconnectApp(x.id, `no-such-client-${SUFFIX}`)).toEqual(
					zeros,
				);
				expect(await disconnectApp(x.id, client.clientId)).toEqual(zeros);
				expect(await snapshot(y.id, client.clientId)).toEqual(yBefore);
			});

			it("leaves the caller's grant to ANOTHER app untouched", async () => {
				const kept = await freshClient("kept");
				const dropped = await freshClient("dropped");
				const x = await freshUser();
				await grantWithRefresh(kept, x.cookie);
				await grantWithRefresh(dropped, x.cookie);
				await pendingCode(kept, x.cookie, "email");
				await pendingCode(dropped, x.cookie, "email");
				const keptBefore = await snapshot(x.id, kept.clientId);
				expect(keptBefore.codes).toHaveLength(1);

				expect(await disconnectApp(x.id, dropped.clientId)).toEqual({
					consentsDeleted: 1,
					refreshTokensDeleted: 1,
					codesDeleted: 1,
				});
				expect(await snapshot(x.id, kept.clientId)).toEqual(keptBefore);
			});

			it("is not blocked by someone else's code that Postgres cannot parse", async () => {
				const client = await freshClient("nul-state");
				const x = await freshUser();
				const y = await freshUser();
				await grantWithRefresh(client, x.cookie);
				await grantWithRefresh(client, y.cookie);
				// `state=%00` is accepted by the provider and stored as "\u0000":
				// valid JSON that `::json` and `::jsonb` both refuse to read.
				const { location } = await oauth.startAuthorize(
					loaded,
					client,
					y.cookie,
					{ scope: "email", state: "\u0000" },
				);
				expect(location.searchParams.get("code")).toBeTruthy();
				const yCodes = (await snapshot(y.id, client.clientId)).codes;
				expect(yCodes).toHaveLength(1);
				expect(yCodes[0]).toMatch(/\\+u0000/);

				expect(await disconnectApp(x.id, client.clientId)).toEqual({
					consentsDeleted: 1,
					refreshTokensDeleted: 1,
					codesDeleted: 0,
				});
				expect((await snapshot(y.id, client.clientId)).codes).toEqual(yCodes);
			});

			it("is atomic: a failing consent delete rolls the token and code deletes back", async () => {
				const client = await freshClient("atomic");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);
				await pendingCode(client, x.cookie, "email");
				const before = await snapshot(x.id, client.clientId);

				const failing = beforeConsentDelete(async () => {
					throw new Error("delete failed");
				});
				await expect(
					disconnectApp(x.id, client.clientId, failing),
				).rejects.toThrow("delete failed");
				expect(await snapshot(x.id, client.clientId)).toEqual(before);
			});

			it("a mint racing the disconnect waits on its lock, then is refused", async () => {
				const client = await freshClient("race");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);

				// Stand in for the provider inserting a rotated refresh token, or one
				// minted by a code redeemed a moment ago, while the disconnect is open:
				// on a separate connection, after the tokens were deleted and before the
				// consent is. Without the lock its insert would find the consent still
				// there, commit, and survive the transaction.
				const racingId = `racing-${SUFFIX}`;
				let racing: Promise<unknown> | undefined;
				const withRace = beforeConsentDelete(async () => {
					racing = insertRawRefresh(racingId, client.clientId, x.id).catch(
						(e: unknown) => e,
					);
					// Proceed only once the insert is actually waiting on a lock, so
					// the test cannot pass by the insert simply running late.
					const deadline = Date.now() + 5_000;
					for (;;) {
						const waiting = await testDb.execute<{ n: string }>(
							sql`select count(*)::text as n from pg_stat_activity where wait_event_type = 'Lock' and query like ${`%${racingId}%`} and pid <> pg_backend_pid()`,
						);
						if (waiting.rows[0]?.n === "1") break;
						if (Date.now() > deadline) {
							throw new Error("the racing mint never waited on the lock");
						}
						await new Promise((r) => setTimeout(r, 25));
					}
				});

				await disconnectApp(x.id, client.clientId, withRace);
				const outcome = await racing;
				expect(errorText(outcome)).toContain("holds no oauth_consent");
				expect(await refreshCount(x.id, client.clientId)).toBe(0);
			});
		});

		describe("the consent trigger (migration 0087)", () => {
			it("refuses a refresh token for a user with no consent for the client", async () => {
				const client = await freshClient("trigger");
				const x = await freshUser();
				const refused = await insertRawRefresh(
					`orphan-${SUFFIX}`,
					client.clientId,
					x.id,
				).catch((e: unknown) => e);
				expect(errorText(refused)).toContain("holds no oauth_consent");
				expect(await refreshCount(x.id, client.clientId)).toBe(0);
			});

			it("exempts a client registered with skip_consent", async () => {
				const client = await freshClient("skip-consent");
				const x = await freshUser();
				await testDb.execute(
					sql`update oauth_client set skip_consent = true where client_id = ${client.clientId}`,
				);
				await insertRawRefresh(`skip-${SUFFIX}`, client.clientId, x.id);
				expect(await refreshCount(x.id, client.clientId)).toBe(1);
			});
		});

		describe("orphaned refresh tokens", () => {
			it("are listed with no approval date, and Disconnect removes them", async () => {
				const client = await freshClient("orphan");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);
				// What Better Auth's own /oauth2/delete-consent leaves behind.
				await testDb.execute(
					sql`delete from oauth_consent where user_id = ${x.id} and client_id = ${client.clientId}`,
				);

				const [app, ...rest] = await listConnectedApps(x.id);
				expect(rest).toEqual([]);
				expect(app?.clientId).toBe(client.clientId);
				expect(app?.name).toBe(`grants orphan ${SUFFIX}`);
				expect(app?.approvedAt).toBeNull();
				expect(app?.lastActiveAt).toBeInstanceOf(Date);

				expect(await disconnectApp(x.id, client.clientId)).toEqual({
					consentsDeleted: 0,
					refreshTokensDeleted: 1,
					codesDeleted: 0,
				});
				expect(await listConnectedApps(x.id)).toEqual([]);
			});

			it("are not listed once expired or revoked", async () => {
				const client = await freshClient("orphan-dead");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);
				await grantWithRefresh(client, x.cookie);
				await testDb.execute(
					sql`delete from oauth_consent where user_id = ${x.id} and client_id = ${client.clientId}`,
				);
				const ids = (
					await testDb.execute<{ id: string }>(
						sql`select id from oauth_refresh_token where user_id = ${x.id} and client_id = ${client.clientId} order by id`,
					)
				).rows.map((r) => r.id);
				await testDb.execute(
					sql`update oauth_refresh_token set revoked = now() where id = ${ids[0]}`,
				);
				await testDb.execute(
					sql`update oauth_refresh_token set expires_at = now() - interval '1 minute' where id = ${ids[1]}`,
				);
				expect(await listConnectedApps(x.id)).toEqual([]);
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

			it("a code issued before the disconnect cannot be redeemed after it", async () => {
				const client = await freshClient("late-code");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);
				// No offline_access, so no refresh token is minted on redemption and
				// only the code delete stands between this code and an access token.
				const held = await pendingCode(client, x.cookie, "email");
				// Control: an identical code redeems while the grant is live.
				const control = await pendingCode(client, x.cookie, "email");
				await oauth.redeemCode(loaded, client, control.code, control.verifier);

				await disconnectApp(x.id, client.clientId);

				await expect(
					oauth.redeemCode(loaded, client, held.code, held.verifier),
				).rejects.toThrow(/invalid_grant/);
			});

			it("an offline code redeemed after the disconnect mints no refresh token", async () => {
				const client = await freshClient("late-offline");
				const x = await freshUser();
				await grantWithRefresh(client, x.cookie);
				const held = await pendingCode(client, x.cookie, "offline_access");

				await disconnectApp(x.id, client.clientId);

				await expect(
					oauth.redeemCode(loaded, client, held.code, held.verifier),
				).rejects.toThrow();
				expect(await refreshCount(x.id, client.clientId)).toBe(0);
			});

			it("replaying a disconnected token cannot wipe out a later reconnection", async () => {
				const client = await freshClient("replay");
				const x = await freshUser();
				const old = await grantWithRefresh(client, x.cookie);
				await disconnectApp(x.id, client.clientId);
				// The person reconnects: consent screen again, a new grant.
				const fresh = await grantWithRefresh(client, x.cookie);

				// A stale retry of the disconnected token. Had it been kept as a
				// revoked row, the provider would read it as token theft and delete
				// every refresh token for this user × client, the new one included.
				const replay = await oauth.refreshGrant(loaded, client, old);
				expect(replay.status).toBe(400);

				const renewed = await oauth.refreshGrant(loaded, client, fresh);
				expect(renewed.status).toBe(200);
			});
		});
	},
);

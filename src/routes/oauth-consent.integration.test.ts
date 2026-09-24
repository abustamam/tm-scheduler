/**
 * The browser half of the claude.ai connect flow (#843), driven through the
 * REAL `auth.handler` against the test database: sign-in resuming an
 * authorize request, the consent screen's lookup, and what the provider does
 * with accept and decline.
 *
 * The pages themselves are rendered in `oauth.consent.test.tsx`; what this
 * file proves is that the URLs those pages build are ones the provider
 * accepts — which is where this flow actually broke while it was being built.
 *
 * Since #852 it also carries the two rules that decide who may connect what:
 * only an officer may APPROVE (every approving case below signs in as one,
 * via `officerCookie`), and only hosted Claude's Client ID Metadata Document
 * is fetched — served here from `src/test/fixtures/claude-cimd-metadata.json`
 * by mocking the one transport module, so nothing calls claude.ai.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/routes/oauth-consent.integration.test.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { clubs, members, officerTerms, people } from "#/db/schema";
import { fetchClientMetadataResource } from "#/lib/cimd-transport";
import { magicLinkCallbackURL } from "#/lib/magic-link-callback";
import { oauthAuthorizeContinuation } from "#/lib/oauth-continuation";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// The CIMD transport, and nothing else on the network: `cimd()` calls this
// for every metadata document it fetches, so a spy here is how a test proves
// a refused client id was never fetched at all.
vi.mock("#/lib/cimd-transport", () => ({
	fetchClientMetadataResource: vi.fn(),
}));

const oauth = await import("#/test/oauth-flow");
const { lookupConsentClient } = await import("#/server/oauth-consent-logic");
const { handleMcpRequest } = await import("#/server/mcp/handle-request");

/** Hosted Claude's client id: the one URL `CIMD_ALLOWED_CLIENT_IDS` admits. */
const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

/**
 * The live document as fetched 2026-09-23. Whitespace is the repo formatter's
 * (Biome formats JSON under `src/`); every key and value is the document's.
 * Never edit it to make a test pass — a change here is claude.ai changing.
 */
const CLAUDE_CIMD_DOCUMENT = readFileSync(
	join(import.meta.dirname, "../test/fixtures/claude-cimd-metadata.json"),
	"utf8",
);

/** A fresh client address per request; see `clientIp` in `#/test/oauth-flow`. */
function clientIp(): string {
	const [a, b] = randomBytes(2);
	return `198.18.${a ?? 0}.${1 + ((b ?? 0) % 254)}`;
}

/** Serve the fixture for Claude's URL, as claude.ai serves it; refuse anything else. */
function serveClaudeDocument(): void {
	vi.mocked(fetchClientMetadataResource).mockImplementation(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== CLAUDE_CLIENT_ID)
			throw new TypeError(`unexpected fetch ${url}`);
		return new Response(CLAUDE_CIMD_DOCUMENT, {
			status: 200,
			headers: {
				"content-type": "application/json",
				"cache-control": "public, max-age=300",
			},
		});
	});
}

describe.skipIf(!hasTestDb)(
	"the OAuth sign-in and consent round trip (#843)",
	() => {
		const SUFFIX = randomBytes(4).toString("hex");
		const SUPERADMIN = `consent-admin-${SUFFIX}@example.com`;
		const emails = new Set<string>([SUPERADMIN]);
		let emailCount = 0;
		/** A fresh, never-seen user per test, so no consent carries over. */
		const freshEmail = () => {
			const email = `consent-user-${SUFFIX}-${emailCount++}@example.com`;
			emails.add(email);
			return email;
		};
		let loaded: Awaited<ReturnType<typeof oauth.loadAuthForTest>>;
		let client: Awaited<ReturnType<typeof oauth.registerClient>>;
		const CLIENT_NAME = `consent probe ${SUFFIX}`;
		/** The club every officer here is an admin of. */
		let club: SeededClub;
		/** A club that is archived, for the "officer only of an archived club" case. */
		let archivedClub: SeededClub;

		beforeAll(async () => {
			loaded = await oauth.loadAuthForTest(SUPERADMIN);
			const superCookie = await oauth.signInCookie(loaded, SUPERADMIN);
			client = await oauth.registerClient(loaded, superCookie, CLIENT_NAME);
			club = await seedClub();
			archivedClub = await seedClub();
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, archivedClub.clubId));
		});

		afterAll(async () => {
			await oauth.cleanupOAuth(
				client ? [client.clientId, CLAUDE_CLIENT_ID] : [CLAUDE_CLIENT_ID],
				[...emails],
			);
			for (const seeded of [club, archivedClub]) {
				if (seeded)
					await cleanup(seeded.clubId, [
						seeded.adminUserId,
						seeded.memberUserId,
					]);
			}
			loaded.restoreEnv();
		});

		/**
		 * Give the session's user an ACTIVE membership in `clubId` — as an admin
		 * by default, which is what `mayUseConnector` admits. `cleanup` removes
		 * the membership and the Person with the club.
		 */
		async function joinClub(
			cookie: string,
			clubId: string,
			clubRole: "admin" | "member" = "admin",
		): Promise<{ userId: string; memberId: string }> {
			const session = await loaded.auth.api.getSession({
				headers: new Headers({ cookie }),
			});
			if (!session) throw new Error("cookie carries no session");
			const { id: userId, email } = session.user;
			const [person] = await testDb
				.insert(people)
				.values({ name: "Consent User", email, userId })
				.returning({ id: people.id });
			const [member] = await testDb
				.insert(members)
				.values({
					clubId,
					personId: person?.id as string,
					name: "Consent User",
					email,
					clubRole,
					status: "active",
				})
				.returning({ id: members.id });
			return { userId, memberId: member?.id as string };
		}

		/** A fresh user, signed in, who is an admin of the open club. */
		async function officerCookie(): Promise<{ email: string; cookie: string }> {
			const email = freshEmail();
			const cookie = await oauth.signInCookie(loaded, email);
			await joinClub(cookie, club.clubId);
			return { email, cookie };
		}

		async function consentRows(email: string): Promise<number> {
			const rows = await testDb.execute<{ n: string }>(
				sql`select count(*)::text as n from oauth_consent c join "user" u on u.id = c.user_id where u.email = ${email} and c.client_id = ${client.clientId}`,
			);
			return Number(rows.rows[0]?.n ?? "-1");
		}

		it("signed out: authorize → /signin → magic link opened ANYWHERE → consent → code", async () => {
			// 1. claude.ai starts the flow in a browser with no GavelUp session.
			const start = await oauth.startAuthorize(loaded, client, null);
			expect(start.location.pathname).toBe("/signin");

			// 2. /signin turns the signed prompt back into the authorize request and
			//    mails a link to it — escaped, as `signin.tsx` sends it.
			const continuation = oauthAuthorizeContinuation(start.location.search);
			expect(continuation).not.toBeNull();
			const email = freshEmail();
			const verified = await oauth.openMagicLink(
				loaded,
				email,
				magicLinkCallbackURL(continuation as string),
			);

			// 3. The link, opened in a cookie-less browser (a second device), lands
			//    on EXACTLY the continuation — not a doubly-decoded copy of it.
			expect(verified.status).toBe(302);
			expect(verified.headers.get("location")).toBe(
				new URL(continuation as string, oauth.TEST_ORIGIN).href,
			);
			const cookie = oauth.cookieHeaderFrom(verified);
			await joinClub(cookie, club.clubId);

			// 4. Following it with the new session reaches consent, freshly signed.
			const authorize = await oauth.follow(
				loaded,
				continuation as string,
				cookie,
			);
			const consentUrl = new URL(
				authorize.headers.get("location") ?? "",
				oauth.TEST_ORIGIN,
			);
			expect(consentUrl.pathname).toBe("/oauth/consent");
			expect(consentUrl.searchParams.get("sig")).toBeTruthy();

			// 5. Accepting there issues a code to the registered redirect URI.
			const accepted = await oauth.postConsent(
				loaded,
				cookie,
				consentUrl.search.slice(1),
				true,
			);
			expect(accepted.status).toBe(200);
			const next = new URL(((await accepted.json()) as { url: string }).url);
			expect(`${next.origin}${next.pathname}`).toBe(oauth.TEST_REDIRECT_URI);
			expect(next.searchParams.get("code")).toBeTruthy();
			expect(await consentRows(email)).toBe(1);
		});

		it("signed out ON the consent screen: the bounce replays authorize, which re-signs", async () => {
			// `/oauth/consent` bounces a signed-out visitor to `/signin?redirect=`
			// the continuation of its OWN query. A consent query is ten minutes from
			// expiring when it is issued; replaying authorize is what lets a magic
			// link opened later still work.
			const { email, cookie } = await officerCookie();
			const { location } = await oauth.startAuthorize(loaded, client, cookie);
			expect(location.pathname).toBe("/oauth/consent");

			const continuation = oauthAuthorizeContinuation(
				location.search,
			) as string;
			const verified = await oauth.openMagicLink(
				loaded,
				email,
				magicLinkCallbackURL(continuation),
			);
			const second = oauth.cookieHeaderFrom(verified);
			const again = await oauth.follow(loaded, continuation, second);
			const consentUrl = new URL(
				again.headers.get("location") ?? "",
				oauth.TEST_ORIGIN,
			);
			expect(consentUrl.pathname).toBe("/oauth/consent");
			expect(consentUrl.searchParams.get("sig")).not.toBe(
				location.searchParams.get("sig") ?? "",
			);
			const accepted = await oauth.postConsent(
				loaded,
				second,
				consentUrl.search.slice(1),
				true,
			);
			expect(accepted.status).toBe(200);
		});

		it("prompt=login does not loop: the resumed authorize reaches consent", async () => {
			// Two review passes reproduced the loop against the real provider: the
			// replayed authorize still said prompt=login, so a person who had just
			// signed in was sent back to /signin, which mailed another link.
			const start = await oauth.startAuthorize(loaded, client, null, {
				prompt: "login",
				max_age: "0",
			});
			expect(start.location.pathname).toBe("/signin");
			const continuation = oauthAuthorizeContinuation(
				start.location.search,
			) as string;
			const verified = await oauth.openMagicLink(
				loaded,
				freshEmail(),
				magicLinkCallbackURL(continuation),
			);
			const resumed = await oauth.follow(
				loaded,
				continuation,
				oauth.cookieHeaderFrom(verified),
			);
			const next = new URL(
				resumed.headers.get("location") ?? "",
				oauth.TEST_ORIGIN,
			);
			expect(next.pathname).toBe("/oauth/consent");
		});

		describe("Approve connects the account the screen showed, or nothing", () => {
			it("refuses an approval sent with a DIFFERENT account's session, and records nothing for it", async () => {
				// Consent opened as A; the person then signs in as B in another tab
				// and presses Approve on the still-open page that reads "A".
				// Both officers, so what refuses is the account binding and not
				// the officer gate.
				const { email: a, cookie: cookieA } = await officerCookie();
				const { email: b, cookie: cookieB } = await officerCookie();
				const { location } = await oauth.startAuthorize(
					loaded,
					client,
					cookieA,
				);
				const shownUser = await oauth.sessionUserId(loaded, cookieA);

				const res = await oauth.postConsent(
					loaded,
					cookieB,
					location.search.slice(1),
					true,
					shownUser,
				);
				expect(res.status).toBe(400);
				expect(((await res.json()) as { error?: string }).error).toBe(
					"account_changed",
				);
				expect(await consentRows(b)).toBe(0);
				expect(await consentRows(a)).toBe(0);
			});

			it("refuses an approval that names no account at all", async () => {
				const { email, cookie } = await officerCookie();
				const { location } = await oauth.startAuthorize(loaded, client, cookie);
				const res = await oauth.postConsent(
					loaded,
					cookie,
					location.search.slice(1),
					true,
					null,
				);
				expect(res.status).toBe(400);
				expect(await consentRows(email)).toBe(0);
			});

			it("still approves when the account matches (control)", async () => {
				const { email, cookie } = await officerCookie();
				const { location } = await oauth.startAuthorize(loaded, client, cookie);
				const res = await oauth.postConsent(
					loaded,
					cookie,
					location.search.slice(1),
					true,
				);
				expect(res.status).toBe(200);
				expect(await consentRows(email)).toBe(1);
			});
		});

		it("PIN: Better Auth's magic link decodes its callback twice", async () => {
			// Why `magicLinkCallbackURL` exists. An UNESCAPED callback holding `%2B`
			// comes back as `+`, which a query parser then reads as a space — the
			// consent signature broke exactly this way in a real browser. The day
			// this assertion fails, Better Auth has fixed the double decode and the
			// escape is corrupting every callback instead: delete both together.
			const target = "/oauth/consent?sig=ab%2Bcd%2Fef%3D&x=1";
			const raw = await oauth.openMagicLink(loaded, freshEmail(), target);
			expect(raw.headers.get("location")).toBe(
				`${oauth.TEST_ORIGIN}/oauth/consent?sig=ab+cd/ef=&x=1`,
			);
			const escaped = await oauth.openMagicLink(
				loaded,
				freshEmail(),
				magicLinkCallbackURL(target),
			);
			expect(escaped.headers.get("location")).toBe(
				`${oauth.TEST_ORIGIN}${target}`,
			);
		});

		it("decline records no consent and issues no code", async () => {
			const email = freshEmail();
			const cookie = await oauth.signInCookie(loaded, email);
			const { location } = await oauth.startAuthorize(loaded, client, cookie);
			const declined = await oauth.postConsent(
				loaded,
				cookie,
				location.search.slice(1),
				false,
			);
			expect(declined.status).toBe(200);
			const body = (await declined.json()) as { url: string };
			expect(new URL(body.url).searchParams.get("error")).toBe("access_denied");
			expect(new URL(body.url).searchParams.get("code")).toBeNull();
			expect(await consentRows(email)).toBe(0);
		});

		it("refuses a consent whose query was altered — the page's error path is real", async () => {
			const { email, cookie } = await officerCookie();
			const { location } = await oauth.startAuthorize(loaded, client, cookie);
			const tampered = location.search
				.slice(1)
				.replace(/state=[^&]*/, "state=attacker");
			const res = await oauth.postConsent(loaded, cookie, tampered, true);
			expect(res.ok).toBe(false);
			expect(await consentRows(email)).toBe(0);
		});

		describe("lookupConsentClient", () => {
			it("names the registered client for a signed-in officer, and says they may approve", async () => {
				const { email, cookie } = await officerCookie();
				const lookup = await lookupConsentClient(
					new Headers({ cookie }),
					client.clientId,
				);
				expect(lookup).toEqual({
					signedIn: true,
					userId: await oauth.sessionUserId(loaded, cookie),
					email,
					eligible: true,
					client: { clientId: client.clientId, name: CLIENT_NAME },
				});
			});

			it("says a person who is an officer nowhere may not approve", async () => {
				const email = freshEmail();
				const cookie = await oauth.signInCookie(loaded, email);
				const lookup = await lookupConsentClient(
					new Headers({ cookie }),
					client.clientId,
				);
				expect(lookup).toMatchObject({ signedIn: true, eligible: false });
			});

			it("says signed-out rather than failing the lookup", async () => {
				expect(
					await lookupConsentClient(new Headers(), client.clientId),
				).toEqual({
					signedIn: false,
				});
			});

			it("degrades an unknown client to null instead of throwing", async () => {
				const email = freshEmail();
				const cookie = await oauth.signInCookie(loaded, email);
				const lookup = await lookupConsentClient(
					new Headers({ cookie }),
					"no-such-client",
				);
				expect(lookup).toEqual({
					signedIn: true,
					userId: await oauth.sessionUserId(loaded, cookie),
					email,
					eligible: false,
					client: null,
				});
			});
		});

		describe("only a club officer may approve (#852)", () => {
			/** Authorize as `cookie` and POST an approval straight to the provider. */
			async function approveAs(cookie: string): Promise<Response> {
				const { location } = await oauth.startAuthorize(loaded, client, cookie);
				expect(location.pathname).toBe("/oauth/consent");
				return oauth.postConsent(
					loaded,
					cookie,
					location.search.slice(1),
					true,
				);
			}

			async function expectRefused(res: Response, email: string) {
				expect(res.status).toBe(403);
				expect(await res.json()).toMatchObject({ error: "not_an_officer" });
				expect(await consentRows(email)).toBe(0);
			}

			it("refuses a plain member's direct approval and records nothing", async () => {
				const email = freshEmail();
				const cookie = await oauth.signInCookie(loaded, email);
				await joinClub(cookie, club.clubId, "member");
				await expectRefused(await approveAs(cookie), email);
			});

			it("refuses someone who is in no club at all", async () => {
				const email = freshEmail();
				const cookie = await oauth.signInCookie(loaded, email);
				await expectRefused(await approveAs(cookie), email);
			});

			it("refuses an admin whose only club is archived", async () => {
				const email = freshEmail();
				const cookie = await oauth.signInCookie(loaded, email);
				await joinClub(cookie, archivedClub.clubId);
				await expectRefused(await approveAs(cookie), email);
			});

			it("approves an elected officer who is not a stored admin", async () => {
				const email = freshEmail();
				const cookie = await oauth.signInCookie(loaded, email);
				const { memberId } = await joinClub(cookie, club.clubId, "member");
				await testDb
					.insert(officerTerms)
					.values({ membershipId: memberId, position: "secretary" });
				const res = await approveAs(cookie);
				expect(res.status).toBe(200);
				expect(await consentRows(email)).toBe(1);
			});

			it("still lets a non-officer DECLINE, so the app stops waiting", async () => {
				const email = freshEmail();
				const cookie = await oauth.signInCookie(loaded, email);
				const { location } = await oauth.startAuthorize(loaded, client, cookie);
				const res = await oauth.postConsent(
					loaded,
					cookie,
					location.search.slice(1),
					false,
				);
				expect(res.status).toBe(200);
				const body = (await res.json()) as { url: string };
				expect(new URL(body.url).searchParams.get("error")).toBe(
					"access_denied",
				);
			});
		});

		describe("hosted Claude connects by Client ID Metadata Document (#852)", () => {
			afterEach(() => {
				vi.mocked(fetchClientMetadataResource).mockReset();
				vi.restoreAllMocks();
			});

			/** `GET /oauth2/authorize` for a URL client id, as claude.ai starts it. */
			async function authorizeByUrl(
				clientId: string,
				cookie: string,
				extra: Record<string, string> = {},
			): Promise<{ response: Response; verifier: string }> {
				const verifier = randomBytes(32).toString("base64url");
				const url = new URL(`${oauth.TEST_ISSUER}/oauth2/authorize`);
				url.search = new URLSearchParams({
					response_type: "code",
					client_id: clientId,
					redirect_uri: CLAUDE_REDIRECT_URI,
					code_challenge: createHash("sha256")
						.update(verifier)
						.digest("base64url"),
					code_challenge_method: "S256",
					state: randomBytes(8).toString("hex"),
					resource: oauth.TEST_RESOURCE,
					...extra,
				}).toString();
				const response = await loaded.handler(
					new Request(url, {
						headers: { accept: "text/html", cookie, "x-real-ip": clientIp() },
					}),
				);
				return { response, verifier };
			}

			/** `POST /oauth2/token` as a PUBLIC client: a client id and no secret. */
			function tokenRequest(params: Record<string, string>): Promise<Response> {
				return loaded.handler(
					new Request(`${oauth.TEST_ISSUER}/oauth2/token`, {
						method: "POST",
						headers: {
							"content-type": "application/x-www-form-urlencoded",
							"x-real-ip": clientIp(),
						},
						body: new URLSearchParams({
							client_id: CLAUDE_CLIENT_ID,
							resource: oauth.TEST_RESOURCE,
							...params,
						}).toString(),
					}),
				);
			}

			/** Authorize → consent → code → token, with no client secret anywhere. */
			async function claudeGrant(
				cookie: string,
				extra: Record<string, string> = {},
			): Promise<{
				consentLocation: URL;
				tokens: { access_token: string; refresh_token?: string };
			}> {
				const { response, verifier } = await authorizeByUrl(
					CLAUDE_CLIENT_ID,
					cookie,
					extra,
				);
				const consentLocation = new URL(
					response.headers.get("location") ?? "",
					oauth.TEST_ORIGIN,
				);
				expect(consentLocation.pathname, await response.clone().text()).toBe(
					"/oauth/consent",
				);
				const consent = await oauth.postConsent(
					loaded,
					cookie,
					consentLocation.search.slice(1),
					true,
				);
				expect(consent.status).toBe(200);
				const next = new URL(((await consent.json()) as { url: string }).url);
				expect(`${next.origin}${next.pathname}`).toBe(CLAUDE_REDIRECT_URI);
				const code = next.searchParams.get("code");
				expect(code).toBeTruthy();
				const redeemed = await tokenRequest({
					grant_type: "authorization_code",
					code: code as string,
					code_verifier: verifier,
					redirect_uri: CLAUDE_REDIRECT_URI,
				});
				expect(redeemed.status, await redeemed.clone().text()).toBe(200);
				return {
					consentLocation,
					tokens: (await redeemed.json()) as {
						access_token: string;
						refresh_token?: string;
					},
				};
			}

			const refusalLogs = (spy: { mock: { calls: unknown[][] } }) =>
				spy.mock.calls.filter(
					(call) => call[0] === "[oauth] refused CIMD client_id",
				);

			it("grants the live Claude document end to end as a public client, and the token calls whoami", async () => {
				serveClaudeDocument();
				const info = vi.spyOn(console, "info");
				const { email, cookie } = await officerCookie();
				const { consentLocation, tokens } = await claudeGrant(cookie);

				// The consent screen names the client from its document.
				const lookup = await lookupConsentClient(
					new Headers({ cookie }),
					consentLocation.searchParams.get("client_id") as string,
				);
				expect(lookup).toMatchObject({
					eligible: true,
					client: { clientId: CLAUDE_CLIENT_ID, name: "Claude" },
				});
				expect(fetchClientMetadataResource).toHaveBeenCalled();
				expect(refusalLogs(info)).toEqual([]);

				// A public client: no secret was ever issued or stored.
				const [row] = (
					await testDb.execute<{
						client_secret: string | null;
						token_endpoint_auth_method: string | null;
					}>(
						sql`select client_secret, token_endpoint_auth_method from oauth_client where client_id = ${CLAUDE_CLIENT_ID}`,
					)
				).rows;
				expect(row).toEqual({
					client_secret: null,
					token_endpoint_auth_method: "none",
				});

				const restoreFetch = oauth.routeJwksToHandler(loaded.handler);
				try {
					const res = await handleMcpRequest(
						new Request("https://club.test/api/mcp", {
							method: "POST",
							headers: {
								"content-type": "application/json",
								accept: "application/json, text/event-stream",
								authorization: `Bearer ${tokens.access_token}`,
							},
							body: JSON.stringify({
								jsonrpc: "2.0",
								id: 1,
								method: "tools/call",
								params: { name: "whoami", arguments: {} },
							}),
						}),
					);
					expect(res.status).toBe(200);
					const parsed = (await res.json()) as {
						result?: {
							isError?: boolean;
							structuredContent?: { user?: { email?: string } };
						};
					};
					expect(parsed.result?.isError).toBeFalsy();
					expect(parsed.result?.structuredContent?.user?.email).toBe(email);
				} finally {
					restoreFetch();
				}
			});

			it("rotates a public client's refresh token, and refuses the old one", async () => {
				serveClaudeDocument();
				const { cookie } = await officerCookie();
				const { tokens } = await claudeGrant(cookie, {
					scope: "email offline_access",
				});
				const first = tokens.refresh_token;
				expect(first).toBeTruthy();

				const renewed = await tokenRequest({
					grant_type: "refresh_token",
					refresh_token: first as string,
				});
				expect(renewed.status, await renewed.clone().text()).toBe(200);
				const second = ((await renewed.json()) as { refresh_token?: string })
					.refresh_token;
				expect(second).toBeTruthy();
				expect(second).not.toBe(first);

				// `mcp()` defaults a 30-second reuse window: a client retrying a
				// refresh whose response it lost gets the SAME rotated pair back,
				// not a fresh one — so a replay inside it mints nothing new.
				const retried = await tokenRequest({
					grant_type: "refresh_token",
					refresh_token: first as string,
				});
				expect(retried.status).toBe(200);
				expect(
					((await retried.json()) as { refresh_token?: string }).refresh_token,
				).toBe(second);

				// Once the window has passed, the old token is dead. Moving the
				// window's end into the past is the elapsed 30 seconds, nothing else.
				await testDb.execute(
					sql`update oauth_refresh_token set rotation_replay_expires_at = now() - interval '1 second' where client_id = ${CLAUDE_CLIENT_ID} and rotated_at is not null`,
				);
				const replay = await tokenRequest({
					grant_type: "refresh_token",
					refresh_token: first as string,
				});
				expect(replay.status).toBe(400);
				expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
			});

			it.each([
				[
					"Claude Code's own document",
					"https://claude.ai/oauth/claude-code-client-metadata",
				],
				["an arbitrary origin", `https://evil.example/client-${SUFFIX}`],
			])("refuses %s before fetching it, writes no client, and logs it once", async (_label, clientId) => {
				serveClaudeDocument();
				const info = vi.spyOn(console, "info").mockImplementation(() => {});
				const { cookie } = await officerCookie();
				const { response } = await authorizeByUrl(clientId, cookie);

				const location = response.headers.get("location") ?? "";
				expect(location).not.toContain("/oauth/consent");
				expect(location).not.toContain("code=");
				expect(fetchClientMetadataResource).not.toHaveBeenCalled();
				const rows = await testDb.execute<{ n: string }>(
					sql`select count(*)::text as n from oauth_client where client_id = ${clientId}`,
				);
				expect(rows.rows[0]?.n).toBe("0");
				expect(refusalLogs(info)).toEqual([
					["[oauth] refused CIMD client_id", JSON.stringify(clientId)],
				]);
			});
		});
	},
);

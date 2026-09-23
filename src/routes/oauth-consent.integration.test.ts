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
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/routes/oauth-consent.integration.test.ts
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { magicLinkCallbackURL } from "#/lib/magic-link-callback";
import { oauthAuthorizeContinuation } from "#/lib/oauth-continuation";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const oauth = await import("#/test/oauth-flow");
const { lookupConsentClient } = await import("#/server/oauth-consent-logic");

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

		beforeAll(async () => {
			loaded = await oauth.loadAuthForTest(SUPERADMIN);
			const superCookie = await oauth.signInCookie(loaded, SUPERADMIN);
			client = await oauth.registerClient(loaded, superCookie, CLIENT_NAME);
		});

		afterAll(async () => {
			await oauth.cleanupOAuth(client ? [client.clientId] : [], [...emails]);
			loaded.restoreEnv();
		});

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
			const email = freshEmail();
			const cookie = await oauth.signInCookie(loaded, email);
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
			const email = freshEmail();
			const cookie = await oauth.signInCookie(loaded, email);
			const { location } = await oauth.startAuthorize(loaded, client, cookie);
			const tampered = location.search
				.slice(1)
				.replace(/state=[^&]*/, "state=attacker");
			const res = await oauth.postConsent(loaded, cookie, tampered, true);
			expect(res.ok).toBe(false);
			expect(await consentRows(email)).toBe(0);
		});

		describe("lookupConsentClient", () => {
			it("names the registered client for a signed-in person", async () => {
				const email = freshEmail();
				const cookie = await oauth.signInCookie(loaded, email);
				const lookup = await lookupConsentClient(
					new Headers({ cookie }),
					client.clientId,
				);
				expect(lookup).toEqual({
					signedIn: true,
					email,
					client: { clientId: client.clientId, name: CLIENT_NAME },
				});
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
				expect(lookup).toEqual({ signedIn: true, email, client: null });
			});
		});
	},
);

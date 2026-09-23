import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
	isAPIError,
} from "better-auth/api";
import { jwt, magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";
import { recordAuthInitFailure } from "#/lib/auth-init-status";
import { captureDevMagicLink, isDevLoginEnabled } from "#/lib/dev-login";
import { sendEmail } from "#/lib/email";
import {
	buildInviteEmail,
	buildMagicLinkEmail,
	MAGIC_LINK_EXPIRY_SECONDS,
} from "#/lib/magic-link-email";
import {
	CONSENT_ACCOUNT_CHANGED,
	consentAccountMismatch,
} from "#/lib/oauth-consent-binding";
import { isRefreshRefusal } from "#/lib/oauth-refresh-refusal";
import { isSuperadminUser, reconcileSuperadminFlag } from "#/lib/superadmin";
import {
	AUTH_CONSENT_PATH,
	AUTH_SIGNIN_PATH,
	DISCOVERY_RATE_LIMIT_PATHS,
	mcpResourceUrl,
} from "#/lib/well-known-forward";
import { linkPersonToUser } from "#/server/account-link-logic";

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
	// On EVERY successful sign-in (a new session), run two independent
	// reconciliations. `session.create.after` fires for both new and returning
	// users, so both are idempotent and self-healing on the next sign-in.
	// Each is wrapped independently so one failing never blocks sign-in or the
	// other — worst case the user lands with the pre-existing state.
	//  - #188: link the sign-in account to its roster Person by email match, so
	//    linking works regardless of ordering (Person provisioned before/after).
	//  - #183 / ADR-0016: reconcile the platform superadmin flag from
	//    SUPERADMIN_EMAILS (two-way grant/revoke).
	databaseHooks: {
		session: {
			create: {
				after: async (session) => {
					try {
						await linkPersonToUser(session.userId);
					} catch (err) {
						console.error("account-link on sign-in failed", err);
					}
					try {
						await reconcileSuperadminFlag(session.userId);
					} catch (err) {
						console.error("superadmin reconcile on sign-in failed", err);
					}
				},
			},
		},
	},
	// #843 — Approve connects the account the consent screen showed, or
	// nothing. Better Auth records the grant for whichever session cookie comes
	// with the POST, and its signed query names no user, so a screen opened as
	// A and approved after signing in as B in another tab connected B while
	// still reading "Signed in as A". `#/lib/oauth-consent-binding` has the
	// rule; `/oauth/consent` sends the id it displayed.
	hooks: {
		before: createAuthMiddleware(async (ctx) => {
			if (ctx.path !== "/oauth2/consent") return;
			const session = await getSessionFromCtx(ctx);
			// No session is not an account CHANGE: the endpoint's own session
			// middleware answers it with a 401, which the page reports as having
			// been signed out rather than as "someone else".
			if (!session) return;
			if (consentAccountMismatch(ctx.body, session.user.id)) {
				throw new APIError("BAD_REQUEST", {
					error: CONSENT_ACCOUNT_CHANGED,
					error_description:
						"The signed-in account changed since this page was opened.",
				});
			}
		}),
	},
	// #847 — where the client address comes from. Better Auth reads only
	// `x-forwarded-for` by default; Railway's edge publishes the client in
	// `X-Real-IP` instead, so resolution returned null on EVERY request since
	// launch: `session.ip_address` held the empty string on all of them, and the
	// limiter below fell back to one bucket per path shared by all traffic — 5
	// magic-link requests a minute for the whole app, not 5 each.
	//
	// This list REPLACES the default rather than extending it, and that is half
	// the fix: `x-forwarded-for` is client-settable, and with no
	// `trustedProxies` a single-entry value is trusted as-is, so leaving it
	// consulted lets a caller pick its own rate-limit bucket per request. List
	// only headers the edge sets. If a future host needs `x-forwarded-for`,
	// configure `trustedProxies` so the chain is walked from a known proxy —
	// do not add it here bare.
	advanced: {
		ipAddress: {
			ipAddressHeaders: ["x-real-ip"],
		},
	},
	// #851: migration 0087's trigger refuses a refresh token for a user with no
	// consent, which is what makes Disconnect final. The provider sees a failed
	// INSERT and Better Auth would answer an empty 500; this makes it the
	// `invalid_grant` a client knows to reconnect on. Throwing an APIError from
	// here is how the router turns it into the response.
	//
	// Setting `onError` REPLACES Better Auth's default logging, so the rest
	// reproduces it (better-auth/dist/api/index.mjs, `onError`): a schema error
	// by message, an APIError only when it is a 500 (every 401 and 400 passes
	// through here too), anything else by name. The default's extra message
	// line at an explicit `logger.level` is omitted; this config sets none.
	onAPIError: {
		onError(error, ctx) {
			if (isRefreshRefusal(error)) {
				throw new APIError("BAD_REQUEST", {
					error: "invalid_grant",
					error_description: "this app was disconnected",
				});
			}
			// The default's first branch: a schema problem is logged by message
			// whatever its status, because that is the one an operator needs.
			if (
				error &&
				typeof error === "object" &&
				"message" in error &&
				typeof error.message === "string" &&
				/column|relation|table|does not exist/.test(error.message)
			) {
				ctx.logger.error(error.message);
				return;
			}
			if (isAPIError(error)) {
				if (error.status === "INTERNAL_SERVER_ERROR") {
					ctx.logger.error(error.status, error);
				}
				return;
			}
			ctx.logger.error(
				error && typeof error === "object" && "name" in error
					? String(error.name)
					: "",
				error,
			);
		},
	},
	rateLimit: {
		enabled: true,
		// Global default: 20 requests per 60 s (covers all auth endpoints).
		window: 60,
		max: 20,
		// Tighter rule for the magic-link sign-in path to prevent email-bomb / account-enumeration.
		customRules: {
			"/sign-in/magic-link": { window: 60, max: 5 },
			// …and OFF for the two OAuth discovery documents (#842). They only reach
			// this limiter because `src/routes/[.]well-known.$.ts` forwards them into
			// `auth.handler`, and metering them breaks the connector this change
			// exists to enable. `DISCOVERY_RATE_LIMIT_PATHS` carries the reasoning and
			// is derived from the forwarder's own allowlist, so the two cannot drift.
			...Object.fromEntries(
				DISCOVERY_RATE_LIMIT_PATHS.map((path) => [path, false as const]),
			),
		},
	},
	plugins: [
		magicLink({
			// Magic links are the only way in — keep the window short. Shares one
			// constant with the email copy so the displayed duration can't drift.
			expiresIn: MAGIC_LINK_EXPIRY_SECONDS,
			sendMagicLink: async ({ email, url, metadata }) => {
				// Dev-login (local e2e) completes sign-in without an inbox by
				// redirecting to this same verify URL — stash it. Inert in prod.
				if (isDevLoginEnabled()) {
					captureDevMagicLink(email, url);
				}
				// Admin roster invites (#266) pass `metadata.kind === "invite"` (plus an
				// optional club name) so the copy reads as an invitation; every other
				// caller gets the standard sign-in email. The link itself is identical.
				const isInvite = metadata?.kind === "invite";
				const clubName =
					typeof metadata?.clubName === "string"
						? metadata.clubName
						: undefined;
				const { subject, html, text } = isInvite
					? buildInviteEmail(url, clubName)
					: buildMagicLinkEmail(url);
				await sendEmail({ to: email, subject, html, text });
			},
		}),
		// #842 / ADR-0027 — GavelUp becomes an OAuth 2.1 authorization server so
		// claude.ai can reach `/api/mcp` from Anthropic's cloud, where a pasted
		// `tmk_` bearer token cannot go.
		//
		// `jwt()` is not optional decoration: `mcp()` signs access tokens with it
		// and serves the JWKS `requireMcpAuth` verifies against. It must come
		// FIRST — `getIssuer` reads the jwt plugin's options to decide the issuer.
		jwt(),
		// `mcp()` IS the OAuth provider (it wraps `oauthProvider()` internally), so
		// registering a separate `oauthProvider()` alongside it is an error.
		//
		// Dynamic Client Registration is deliberately OFF: neither
		// `allowDynamicClientRegistration` nor
		// `allowUnauthenticatedClientRegistration` is passed, so the registration
		// endpoint is absent from discovery entirely. claude.ai is one
		// hand-registered confidential client. ADR-0027 has the reasoning.
		//
		// Both pages are this app's (#843). The provider sends each a SIGNED copy
		// of the authorize query, not a `?redirect=`: `/signin` turns it back into
		// an authorize URL for its magic link (`#/lib/oauth-continuation`), and
		// `/oauth/consent` posts it to `/oauth2/consent` as `oauth_query`.
		mcp({
			loginPage: AUTH_SIGNIN_PATH,
			consentPage: AUTH_CONSENT_PATH,
			resource: mcpResourceUrl(),
			// DCR being off is NOT what closes client registration. `/oauth2/register`
			// reads `allowDynamicClientRegistration` and refuses; `/oauth2/create-client`
			// does NOT — it is a separate, routed endpoint carrying only
			// `sessionMiddleware`, and `assertClientPrivileges` is a NO-OP unless this
			// callback exists. Probed on a live server before this line was added: a
			// plain member (`is_superadmin = f`) POSTing their own session got 201 with
			// a client_id, a client_secret, their own `redirect_uris`, their own
			// `client_name`, and `resources: [".../api/mcp"]` auto-attached.
			//
			// That is a consent-phishing primitive the moment #843 ships the consent
			// screen: register "GavelUp Calendar Sync" pointing at your own server,
			// send another member an `/oauth2/authorize` link on the REAL origin, and
			// redeem their code against `/api/mcp`.
			//
			// This one callback is the whole enumeration: the provider calls
			// `assertClientPrivileges` at every create/read/update/delete/list/rotate
			// site, so a future endpoint is covered without editing a list here. It
			// fails closed — a caller with no user is denied — and superadmin is the
			// repo's existing authority for "the maintainer" (ADR-0016), which is what
			// #843's out-of-band registration script runs as.
			//
			// The flag is read from the DATABASE, not from `user.isSuperadmin`. That
			// property is always `undefined`: Better Auth's adapter builds the session
			// user from its OWN table schema and this repo declares no
			// `user.additionalFields`. The first draft of this gate tested it
			// directly, which made the callback `() => false` — the hole was closed
			// against the maintainer as well, and the test below passed anyway because
			// it only asserted the refusal. `isSuperadminUser` is the same read
			// `requireSuperadmin` has always done, and the positive case is now
			// asserted beside the negative one.
			clientPrivileges: async ({ user }) => isSuperadminUser(user?.id),
		}),
		// LAST, and Better Auth logs a warning at startup if it is not: a cookie
		// integration plugin forwards `Set-Cookie` into the framework's cookie
		// store from an `after` hook, so any plugin registered behind it can set a
		// cookie that never reaches the response. #842 put `mcp()` after this and
		// tripped exactly that warning — the OAuth flows #843 builds are
		// cookie-carrying, so the failure would have been a consent round trip
		// that silently loses its session.
		tanstackStartCookies(),
	],
});

/**
 * Report a failed Better Auth init instead of letting it reject unobserved.
 *
 * Since #842 this module does DATABASE I/O at import: `mcp()`'s `init` seeds an
 * `oauth_resource` row for the configured resource. `betterAuth()` starts that
 * eagerly and keeps ONE promise for it, which `auth.handler` awaits — so a
 * failure already reaches every real caller, and attaching a handler here hides
 * nothing. The promise stays rejected; this only gives it an observer.
 *
 * Two things that observer is worth:
 *
 * - In production it names the cause ONCE at boot, and marks the process
 *   unhealthy so `/api/health` fails — on Railway that means this DEPLOY is not
 *   promoted and the previous release keeps serving, which is what should
 *   happen to a release whose auth cannot start. Without it, a seed that fails —
 *   migrations lagging behind the image, most plausibly — surfaces as every
 *   auth request failing with the same opaque error, no first line saying why,
 *   and the healthcheck still answering 200. The failure is NOT OAuth-scoped and
 *   it never clears: `#/lib/auth-init-status` has the three reasons why.
 * - In tests it is the difference between a readable failure and a red build
 *   with green assertions. Around seventeen suites reach this module
 *   transitively (`#/server/guards`) while mocking `#/db` as `{}`, which was
 *   honest until the init write existed. Vitest reports an unhandled rejection
 *   and exits non-zero while every test passes — the exact shape
 *   `src/test/setup-env.ts` documents for the same failure mode.
 *
 * Better Auth does the same thing one layer down with its own schema check
 * (`createBetterAuth` → `pendingSchemaCheck.catch(…)`).
 */
void auth.$context.catch((err) => {
	recordAuthInitFailure(err);
	console.error(
		"better-auth init failed — OAuth resource seeding or schema check did not complete; every auth request will fail with this error until the process restarts",
		err,
	);
});

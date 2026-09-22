import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";
import { captureDevMagicLink, isDevLoginEnabled } from "#/lib/dev-login";
import { sendEmail } from "#/lib/email";
import {
	buildInviteEmail,
	buildMagicLinkEmail,
	MAGIC_LINK_EXPIRY_SECONDS,
} from "#/lib/magic-link-email";
import { reconcileSuperadminFlag } from "#/lib/superadmin";
import {
	AUTH_CONSENT_PATH,
	AUTH_SIGNIN_PATH,
	MCP_RESOURCE_PATH,
} from "#/lib/well-known-forward";
import { linkPersonToUser } from "#/server/account-link-logic";

/**
 * The MCP protected resource this authorization server issues tokens for
 * (#842 / ADR-0027).
 *
 * `mcp()` validates this at CONSTRUCTION — HTTPS, or HTTP on a loopback host,
 * and no query or fragment — so a missing or malformed `BETTER_AUTH_URL` now
 * fails at import rather than on the first sign-in. That is the direction we
 * want: `BETTER_AUTH_URL` is already required (CLAUDE.md, "Environment"), and
 * an authorization server whose issuer is `undefined` must not start at all.
 * The explicit throw is here so the failure names the cause; the library's own
 * `TypeError` would say only that the resource URL is not absolute.
 */
function mcpResourceUrl(): string {
	const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
	if (!base) {
		throw new Error(
			"BETTER_AUTH_URL is required: it is the OAuth issuer and the base of the MCP resource identifier (ADR-0027).",
		);
	}
	return `${base}${MCP_RESOURCE_PATH}`;
}

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
	rateLimit: {
		enabled: true,
		// Global default: 20 requests per 60 s (covers all auth endpoints).
		window: 60,
		max: 20,
		// Tighter rule for the magic-link sign-in path to prevent email-bomb / account-enumeration.
		customRules: {
			"/sign-in/magic-link": { window: 60, max: 5 },
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
		// Neither page named here exists as a completed flow yet — `/signin` does,
		// `/oauth/consent` does not, and nothing in #842 completes an
		// authorization. Both are declared now because the provider reads them at
		// construction; #843 builds the consent round trip.
		mcp({
			loginPage: AUTH_SIGNIN_PATH,
			consentPage: AUTH_CONSENT_PATH,
			resource: mcpResourceUrl(),
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
 * - In production it names the cause ONCE at boot. Without it, a seed that
 *   fails — migrations lagging behind the image, most plausibly — surfaces as
 *   every auth request failing with the same opaque error and no first line
 *   saying why.
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
	console.error(
		"better-auth init failed — OAuth resource seeding or schema check did not complete; every auth request will fail with this error",
		err,
	);
});

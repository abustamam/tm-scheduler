import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
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
		tanstackStartCookies(),
	],
});

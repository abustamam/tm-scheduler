import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";
import { captureDevMagicLink, isDevLoginEnabled } from "#/lib/dev-login";
import { sendEmail } from "#/lib/email";
import {
	buildMagicLinkEmail,
	MAGIC_LINK_EXPIRY_SECONDS,
} from "#/lib/magic-link-email";
import { reconcileSuperadminFlag } from "#/lib/superadmin";

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
	// Reconcile the platform superadmin flag from SUPERADMIN_EMAILS on every
	// sign-in (ADR-0016 / #183). `session.create.after` fires for both new and
	// returning users, giving the two-way grant/revoke on the next sign-in.
	databaseHooks: {
		session: {
			create: {
				after: async (session) => {
					await reconcileSuperadminFlag(session.userId);
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
			sendMagicLink: async ({ email, url }) => {
				// Dev-login (local e2e) completes sign-in without an inbox by
				// redirecting to this same verify URL — stash it. Inert in prod.
				if (isDevLoginEnabled()) {
					captureDevMagicLink(email, url);
				}
				const { subject, html, text } = buildMagicLinkEmail(url);
				await sendEmail({ to: email, subject, html, text });
			},
		}),
		tanstackStartCookies(),
	],
});

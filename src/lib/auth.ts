import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";
import { sendEmail } from "#/lib/email";
import {
	buildMagicLinkEmail,
	MAGIC_LINK_EXPIRY_SECONDS,
} from "#/lib/magic-link-email";

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
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
				const { subject, html, text } = buildMagicLinkEmail(url);
				await sendEmail({ to: email, subject, html, text });
			},
		}),
		tanstackStartCookies(),
	],
});

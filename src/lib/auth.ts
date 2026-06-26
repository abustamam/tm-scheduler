import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";
import { sendEmail } from "./email";
import { buildMagicLinkEmail } from "./magic-link-email";

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
			// Magic links are the only way in — keep the window short. Pinned so
			// the email copy ("expires in 5 minutes") cannot drift from the TTL.
			expiresIn: 60 * 5,
			sendMagicLink: async ({ email, url }) => {
				const { subject, html, text } = buildMagicLinkEmail(url);
				await sendEmail({ to: email, subject, html, text });
			},
		}),
		tanstackStartCookies(),
	],
});

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";

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
			sendMagicLink: async ({ email, url }) => {
				// TODO: wire a real email provider (e.g. Resend / SES) before
				// production. For local dev we just log the link so you can copy it.
				console.log(`\n[magic-link] sign-in link for ${email}:\n${url}\n`);
			},
		}),
		tanstackStartCookies(),
	],
});

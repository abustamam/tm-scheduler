import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
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

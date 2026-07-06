import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";
import { isDevLoginEnabled, takeDevMagicLink } from "#/lib/dev-login";

/**
 * Dev-only sign-in shortcut for local e2e against a seeded DB. Disabled unless
 * NODE_ENV !== "production" AND ENABLE_DEV_LOGIN=1 (see `#/lib/dev-login`).
 *
 * GET /api/dev-login?email=<seed-user>&redirect=/schedule
 *   → issues a real magic link server-side and 302s to Better-Auth's verify
 *     endpoint, which sets the session cookie and then redirects to `redirect`.
 *
 * Use a seeded user, e.g. rasheed.bustamam@gmail.com (admin) or
 * jordan@example.com (President/admin).
 */
export const Route = createFileRoute("/api/dev-login")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				if (!isDevLoginEnabled()) {
					return new Response("Not found", { status: 404 });
				}

				const url = new URL(request.url);
				const email = url.searchParams.get("email");
				const redirect = url.searchParams.get("redirect") ?? "/";
				if (!email) {
					return new Response("Missing ?email", { status: 400 });
				}

				// Issue a magic link; `sendMagicLink` (auth.ts) captures the URL.
				try {
					await auth.api.signInMagicLink({
						body: { email, callbackURL: redirect },
						headers: request.headers,
					});
				} catch (err) {
					return new Response(
						`dev-login: could not issue magic link: ${
							err instanceof Error ? err.message : String(err)
						}`,
						{ status: 500 },
					);
				}

				const verifyUrl = takeDevMagicLink(email);
				if (!verifyUrl) {
					return new Response(
						`dev-login: no magic link captured for ${email} (is it a seeded user?)`,
						{ status: 500 },
					);
				}

				// Hand off to Better-Auth's verify endpoint — it sets the session
				// cookie, then redirects to `redirect`.
				return new Response(null, {
					status: 302,
					headers: { location: verifyUrl },
				});
			},
		},
	},
});

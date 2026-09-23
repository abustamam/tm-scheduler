import { createFileRoute } from "@tanstack/react-router";
import { authInitFailure } from "#/lib/auth-init-status";

// Liveness endpoint for the platform healthcheck (Railway). Returns 200 with no
// auth and no DB access, so it stays green independent of sign-in state and of
// whether migrations have run. (The app's "/" is behind the _authed guard and
// redirects to /signin, which is not a valid 2xx healthcheck target.)
//
// The ONE thing it reports unhealthy for (#842): Better Auth's init failed.
// That is not a blip — `mcp()` seeds a row at import, `betterAuth()` memoizes
// the one init promise that `auth.handler` awaits, and a rejection there fails
// EVERY request, magic-link sign-in included, for the life of the process even
// after the database recovers. A restart is the only fix, so the probe has to
// ask for one. `#/lib/auth-init-status` carries the reasoning and is why this
// is a synchronous flag read rather than an `await auth.$context`: the route
// keeps its no-auth, no-DB, never-hangs properties, and a pending init still
// answers 200 so the probe does not flap during the first moments of a deploy.
export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: () =>
				authInitFailure()
					? new Response("auth init failed", { status: 503 })
					: new Response("ok", { status: 200 }),
		},
	},
});

import { createFileRoute } from "@tanstack/react-router";
import { authHealthResponse } from "#/lib/auth-init-status";

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
// ask for one — on Railway a failing probe means this DEPLOY does not get
// promoted and the previous release keeps serving, which is the right outcome
// for a release whose auth cannot start. `#/lib/auth-init-status` carries the
// reasoning and owns the decision, so both branches are reachable from a test:
// a `createFileRoute` handler body is not (#544), and a ternary left inline
// here would be gated only by source greps that an inversion satisfies. The
// read is synchronous rather than `await auth.$context` so the route keeps its
// no-auth, no-DB, never-hangs properties, and a pending init still answers 200
// so the probe does not flap during the first moments of a deploy.
export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: () => authHealthResponse(),
		},
	},
});

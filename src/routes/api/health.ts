import { createFileRoute } from "@tanstack/react-router";

// Liveness endpoint for the platform healthcheck (Railway). Returns 200 with no
// auth and no DB access, so it stays green independent of sign-in state and of
// whether migrations have run. (The app's "/" is behind the _authed guard and
// redirects to /signin, which is not a valid 2xx healthcheck target.)
export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: () => new Response("ok", { status: 200 }),
		},
	},
});

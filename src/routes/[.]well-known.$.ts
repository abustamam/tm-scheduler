import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";
import { serveWellKnownDiscovery } from "#/lib/well-known-forward";

/**
 * `/.well-known/*` — the two OAuth discovery documents, at the origin root
 * (#842 / ADR-0027).
 *
 * The `[.]` in the filename is TanStack Router's bracket escape: the generator
 * splits a route filename on unescaped dots, so `[.]well-known.$.ts` resolves
 * to the path `/.well-known/$` rather than to a `/well-known` segment. `.` is
 * not in its disallowed-escape set, so this is supported rather than a trick.
 *
 * Both handlers delegate to the same function, which owns the allowlist: GET
 * returns a document or 404, and POST exists only so that a write to an
 * allowlisted document answers 405 with an `Allow` header instead of falling
 * through to the SPA's 404 page. The reasoning — why forward rather than
 * rebuild, and where Better Auth really serves these — lives in
 * `#/lib/well-known-forward`, which is where the tests can reach it: a
 * `createFileRoute` handler body cannot be reached from a test (#544).
 */
export const Route = createFileRoute("/.well-known/$")({
	server: {
		handlers: {
			GET: ({ request }) => serveWellKnownDiscovery(request, auth.handler),
			POST: ({ request }) => serveWellKnownDiscovery(request, auth.handler),
		},
	},
});

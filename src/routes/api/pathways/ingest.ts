import { createFileRoute } from "@tanstack/react-router";
import { IngestError, ingestForToken } from "#/server/pathways-ingest-logic";

/**
 * POST /api/pathways/ingest — the Pathways auto-sync extension (#107) posts here.
 * Auth is a per-club Bearer token (Authorization: Bearer gup_…), NOT a session:
 * the token encodes the club. Body:
 *   { basecampClubGuid, pages: BcmProgressPage[], details?: BcmDetailPayload[] }.
 * `details` is optional (older extension builds omit it); when present, the
 * result gains a `detail` block. Returns the SyncResult (+ optional `warning`,
 * + optional `detail`) as JSON.
 *
 * CORS: the extension POSTs from a `moz-extension://`/`chrome-extension://` origin.
 * Chromium exempts host-permission fetches from CORS, but Firefox does not reliably,
 * so the browser sends a preflight. We answer it and allow any origin — this is safe
 * because auth is a Bearer token, never a cookie (no credentialed CORS), so `*` grants
 * no ambient authority.
 */
const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "POST, OPTIONS",
	"access-control-allow-headers": "authorization, content-type",
	"access-control-max-age": "86400",
};

function json(data: unknown, status: number): Response {
	return Response.json(data, { status, headers: CORS_HEADERS });
}

export const Route = createFileRoute("/api/pathways/ingest")({
	server: {
		handlers: {
			// CORS preflight.
			OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
			POST: async ({ request }) => {
				const header = request.headers.get("authorization") ?? "";
				const token = header.startsWith("Bearer ")
					? header.slice("Bearer ".length)
					: null;

				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return json({ error: "Body must be JSON." }, 400);
				}

				try {
					const result = await ingestForToken(token, body);
					return json(result, 200);
				} catch (err) {
					if (err instanceof IngestError) {
						return json({ error: err.message }, err.status);
					}
					return json({ error: "Sync failed." }, 500);
				}
			},
		},
	},
});

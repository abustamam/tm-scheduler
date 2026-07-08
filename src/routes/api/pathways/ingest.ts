import { createFileRoute } from "@tanstack/react-router";
import {
	IngestError,
	ingestForToken,
	parseBearerToken,
} from "#/server/pathways-ingest-logic";

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

// ~5 MB ceiling on the request body, checked BEFORE parse and before the token
// is trusted. A full 30-member club sync with details is <1 MB, so this only
// trips on hostile/garbage input.
const MAX_BODY_BYTES = 5_000_000;

export const Route = createFileRoute("/api/pathways/ingest")({
	server: {
		handlers: {
			// CORS preflight.
			OPTIONS: () => new Response(null, { status: 204, headers: CORS_HEADERS }),
			POST: async ({ request }) => {
				const token = parseBearerToken(request.headers.get("authorization"));

				// Reject an oversized body before reading it. Check the declared
				// content-length first (cheap), then the actual text length to
				// cover chunked bodies that send no content-length.
				const declared = Number(request.headers.get("content-length") ?? "0");
				if (declared > MAX_BODY_BYTES) {
					return json({ error: "Body too large." }, 413);
				}
				let body: unknown;
				try {
					const text = await request.text();
					if (text.length > MAX_BODY_BYTES) {
						return json({ error: "Body too large." }, 413);
					}
					body = JSON.parse(text);
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
					// The generic 500 hides the cause from the caller by design;
					// log it (timestamp + stack in Railway) so it's debuggable.
					console.error("[ingest] sync failed:", err);
					return json({ error: "Sync failed." }, 500);
				}
			},
		},
	},
});

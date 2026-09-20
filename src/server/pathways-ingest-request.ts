/**
 * The `/api/pathways/ingest` handler (#107), and the CORS answer its preflight
 * needs.
 *
 * It lives here rather than in the route file because a `createFileRoute`
 * handler body cannot be reached from a test (#544), and the body cap this
 * endpoint applies is the kind of behaviour that has to be MEASURED rather than
 * asserted in prose — see `pathways-ingest-request.test.ts`.
 */
import { MAX_INGEST_BODY_BYTES } from "#/lib/pathways-ingest-limits";
import {
	parseDeclaredContentLength,
	readBodyWithinCap,
} from "#/lib/request-body-limits";
import {
	IngestError,
	ingestForToken,
	parseBearerToken,
} from "#/server/pathways-ingest-logic";

/**
 * CORS: the extension POSTs from a `moz-extension://`/`chrome-extension://` origin.
 * Chromium exempts host-permission fetches from CORS, but Firefox does not reliably,
 * so the browser sends a preflight. We answer it and allow any origin — this is safe
 * because auth is a Bearer token, never a cookie (no credentialed CORS), so `*` grants
 * no ambient authority.
 */
export const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "POST, OPTIONS",
	"access-control-allow-headers": "authorization, content-type",
	"access-control-max-age": "86400",
};

function json(data: unknown, status: number): Response {
	return Response.json(data, { status, headers: CORS_HEADERS });
}

/** The CORS preflight. */
export function handlePathwaysIngestPreflight(): Response {
	return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * POST /api/pathways/ingest — the Pathways auto-sync extension (#107) posts here.
 * Auth is a per-club Bearer token (Authorization: Bearer gup_…), NOT a session:
 * the token encodes the club. Body:
 *   { basecampClubGuid, pages: BcmProgressPage[], details?: BcmDetailPayload[] }.
 * `details` is optional (older extension builds omit it); when present, the
 * result gains a `detail` block. Returns the SyncResult (+ optional `warning`,
 * + optional `detail`) as JSON.
 */
export async function handlePathwaysIngestRequest(
	request: Request,
): Promise<Response> {
	const token = parseBearerToken(request.headers.get("authorization"));

	// Bound the body BEFORE it is in memory, and before the token is looked at.
	//
	// Nothing authenticates this endpoint until `ingestForToken` runs, which is
	// after the body has been parsed — so whatever this cap does, it has to do
	// with no credential presented at all. That is how it is reachable (#800).
	//
	// `content-length` is the caller's to write, so it can only REJECT early —
	// it can never authorise a read. It used to be the only pre-read check, and
	// it was read as `Number(header ?? "0")`: an absent header became 0 and a
	// chunked body of any size sailed past, `abc` became NaN and failed the `>`
	// comparison silently. The real ceiling then ran after `await
	// request.text()`, by which point the whole body was already a string in
	// this process — one process, serving the whole app (ADR-0007). So the 5 MB
	// was a label on a 413, not a bound on memory.
	//
	// Now the header is parsed without coercion and the ceiling is enforced
	// WHILE the body streams, cancelling the stream at the byte that crosses it.
	// MEASURED: a 64 MB chunked body reads 77 of its 1000 chunks — 5,046,272
	// bytes, the cap plus the chunk that crossed it — instead of all
	// 65,536,000 (`pathways-ingest-request.test.ts`).
	const declared = parseDeclaredContentLength(
		request.headers.get("content-length"),
	);
	// 400, not 413, and matching `/api/mcp`: a header that is not a byte count
	// is a malformed request whatever the body's size, and answering 413 would
	// claim a measurement nothing has made yet.
	if (declared.kind === "malformed") {
		return json({ error: "Malformed content-length header." }, 400);
	}
	if (declared.kind === "length" && declared.bytes > MAX_INGEST_BODY_BYTES) {
		return json({ error: "Body too large." }, 413);
	}
	const read = await readBodyWithinCap(request, MAX_INGEST_BODY_BYTES);
	if (read.kind === "too-large") {
		return json({ error: "Body too large." }, 413);
	}
	if (read.kind === "unreadable") {
		return json({ error: "Could not read request body." }, 400);
	}
	let body: unknown;
	try {
		body = JSON.parse(read.text);
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
}

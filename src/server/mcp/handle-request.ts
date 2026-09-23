/**
 * `/api/mcp`'s request handler (#773, D1).
 *
 * Exported as a plain `(Request) => Promise<Response>` so tests can drive it
 * with a hand-built `Request` — a `createFileRoute` handler body is unreachable
 * from vitest (#544), and the bearer-only posture is the one claim in this
 * design where being wrong is a security hole, so it has to be testable
 * behaviourally rather than by grepping imports.
 *
 * ## A fresh server AND transport on every request
 *
 * MEASURED against `@modelcontextprotocol/sdk@1.30.0`: in stateless mode
 * (`sessionIdGenerator: undefined`) the transport refuses a second use —
 * `webStandardStreamableHttp.js:172-177` checks `_hasHandledRequest` and
 * rejects. Hoisting the transport (or the `McpServer`) to module scope is the
 * tempting optimisation and it breaks on the SECOND tool call, which is the
 * worst possible failure shape: every smoke test passes, and the thing falls
 * over the moment someone uses it for real. `mcp-route.integration.test.ts`
 * makes two sequential calls against one process for exactly this reason.
 *
 * Constructing a server per request is cheap — it is object graph assembly, no
 * I/O.
 *
 * ## Authentication happens here, before any tool runs
 *
 * Two credential kinds reach this endpoint, told apart by prefix (#843):
 *
 * - `tmk_…` — a personal token (Claude Code, pasted into a header). Passed
 *   down as opaque context; each tool resolves it itself (`authz-logic`).
 * - anything else, or nothing — tried as an OAuth access token (claude.ai).
 *   Better Auth verifies it HERE, before the body is read, and each tool is
 *   handed the verified grant rather than the token.
 *
 * The prefix decides the path outright, so the two never race and a
 * malformed credential fails once. A missing, unknown, revoked, expired or
 * wrong-audience credential is a 401 at the HTTP layer rather than a tool
 * error, because a caller with no valid credential should not learn which
 * tools exist — and every one of those 401s carries a `WWW-Authenticate`
 * challenge naming the protected-resource metadata, which is how an MCP
 * client finds out where to authorize.
 *
 * NO cookie is read, anywhere on this path. Bearer-only is what makes a
 * cross-site POST harmless: it carries no ambient credential. A guard test
 * forbids the cookie-reading imports and a behavioural test sends a real session
 * cookie with no `Authorization` header and asserts 401 plus no writes.
 *
 * NO CORS headers either. The clients are not browsers, so there is no
 * preflight to answer and nothing to grant an origin.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MAX_MCP_BODY_BYTES } from "#/lib/mcp-limits";
import {
	parseDeclaredContentLength,
	readBodyWithinCap,
} from "#/lib/request-body-limits";
import { parseBearerToken } from "#/server/pathways-ingest-logic";
import {
	authenticateToken,
	isPersonalToken,
	McpUnauthorizedError,
} from "./authz-logic";
import { McpError, toMcpError } from "./errors";
import { unauthorizedResponse } from "./oauth-claims";
import { serveWithOAuthCredential } from "./oauth-credential";
import type { McpToolContext } from "./tool";
import { MCP_TOOLS } from "./tools";

/**
 * Sent at MCP `initialize`. This is the protocol the write tools depend on, and
 * it has to be stated to the model rather than only to the human reading the
 * docs: a client that applies without previewing defeats the entire mechanism.
 */
const INSTRUCTIONS = `This server edits a real Toastmasters club's records. Writes are previewed before they happen.

For any write tool:
1. Call it WITHOUT planHash. Nothing is written; you get back a plan, a planHash, and a list of blocking items.
2. Show the plan to the user in full and get an explicit yes. Do not summarise away what it will change.
3. Call the tool again with the SAME input plus that planHash.

Never resolve an entry the plan marks 'ambiguous' on your own — ask the user which person it is, or whether it is someone new. Guessing merges two real people's records or splits one person's into two.

If an apply returns PLAN_STALE, the club changed since the preview. Show the fresh plan it returns and ask again; do not retry automatically.

Start with whoami to get a clubId.`;

function json(data: unknown, status: number): Response {
	return Response.json(data, { status });
}

/** Build a server with every registered tool bound to this request's credential. */
function buildServer(ctx: McpToolContext): McpServer {
	const server = new McpServer(
		{ name: "gavelup", version: "1" },
		{ instructions: INSTRUCTIONS },
	);

	for (const tool of MCP_TOOLS) {
		server.registerTool(
			tool.name,
			{
				title: tool.config.title,
				description: tool.config.description,
				// An absent input schema means "no arguments" (whoami).
				...(tool.config.inputSchema
					? { inputSchema: tool.config.inputSchema }
					: {}),
			},
			// The SDK types the callback against the declared input shape; our
			// handlers take a bare record and re-parse, so the two meet here.
			(async (args: Record<string, unknown>) => {
				try {
					const result = await tool.handler(args ?? {}, ctx);
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(result, null, 2) },
						],
						structuredContent: result as Record<string, unknown>,
					};
				} catch (err) {
					// A revoked token mid-session is still a 401-shaped fact, but by
					// now we are inside a tool call and can only answer as one.
					const mcpErr =
						err instanceof McpUnauthorizedError
							? new McpError("FORBIDDEN", err.message)
							: toMcpError(err, tool.name);
					const body = {
						error: {
							code: mcpErr.code,
							message: mcpErr.message,
							...(mcpErr.detail === undefined ? {} : { detail: mcpErr.detail }),
						},
					};
					return {
						isError: true,
						content: [
							{ type: "text" as const, text: JSON.stringify(body, null, 2) },
						],
						structuredContent: body,
					};
				}
				// biome-ignore lint/suspicious/noExplicitAny: the SDK's callback type is
				// parameterised on each tool's own zod shape; one loop cannot satisfy
				// all of them at once, and the runtime contract is exercised by the
				// transport integration test.
			}) as any,
		);
	}
	return server;
}

export async function handleMcpRequest(request: Request): Promise<Response> {
	const rawToken = parseBearerToken(request.headers.get("authorization"));
	if (rawToken !== null && isPersonalToken(rawToken)) {
		return serveMcp(request, { rawToken });
	}
	try {
		return await serveWithOAuthCredential(
			request,
			async (verified, oauthGrant) => {
				// Caught HERE, so the catch below only ever sees the verifier. Without
				// this, anything `serveMcp` threw after a good token was logged and
				// answered as "could not verify", which sends a diagnosis the wrong
				// way.
				try {
					return await serveMcp(verified, { oauthGrant });
				} catch (err) {
					console.error("[mcp] request failed after OAuth verification:", err);
					return json({ error: "Could not handle that request." }, 500);
				}
			},
		);
	} catch (err) {
		// Better Auth answers every token it can judge with a challenge. What
		// reaches here is the verifier failing to judge at all — the JWKS fetch
		// timing out or refused — which is our outage, not the caller's bad
		// credential, so it is a 500 rather than a 401 that would send claude.ai
		// back through consent for nothing.
		console.error("[mcp] could not verify an OAuth access token:", err);
		return json({ error: "Could not verify that token." }, 500);
	}
}

/** Everything after the credential kind is known: limits, auth, dispatch. */
async function serveMcp(
	request: Request,
	ctx: McpToolContext,
): Promise<Response> {
	// Bound the body BEFORE it is in memory, and before the token is trusted.
	//
	// `content-length` is the caller's to write, so it can only REJECT early —
	// it can never authorise a read. It used to be the only pre-read check, and
	// it was read as `Number(header ?? "0")`: an absent header became 0 and a
	// chunked body of any size sailed past, `abc` became NaN and failed the `>`
	// comparison silently. The real ceiling then ran after `await
	// request.text()`, by which point the whole body was already a string here.
	// So the 1 MB was a label on a 413, not a bound on memory.
	//
	// Now the header is parsed without coercion (a malformed one is refused
	// rather than guessed at) and the ceiling is enforced WHILE the body
	// streams, cancelling the stream at the byte that crosses it. MEASURED: a
	// 64 MB chunked body reads 16 of its 1000 chunks
	// (`request-body-limits.test.ts`, where the reader and its measurement moved
	// when `/api/pathways/ingest` became the second caller — #800).
	const declared = parseDeclaredContentLength(
		request.headers.get("content-length"),
	);
	if (declared.kind === "malformed") {
		return json({ error: "Malformed content-length header." }, 400);
	}
	if (declared.kind === "length" && declared.bytes > MAX_MCP_BODY_BYTES) {
		return json({ error: "Body too large." }, 413);
	}
	const read = await readBodyWithinCap(request, MAX_MCP_BODY_BYTES);
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

	// Reject JSON-RPC BATCHES.
	//
	// Not a style preference — it closes an amplification path. In JSON-response
	// mode the SDK dispatches every message of a batch at once and does not await
	// them (`webStandardStreamableHttp.js:588-591`: `for (const message of
	// messages) { this.onmessage?.(…) }`). A single 1 MB body therefore holds
	// thousands of `tools/call` entries that all start together; each
	// `record_guest_book` apply opens a transaction and blocks on
	// `pg_advisory_xact_lock`, which waits indefinitely while holding its pooled
	// connection. `src/db/index.ts` takes node-postgres' default pool of 10 and
	// the app sets no `statement_timeout`, so ten queued applies from ONE valid
	// token starve the connection pool for the whole web app — not just this
	// endpoint.
	//
	// The endpoint has no use for batching: every tool here is one
	// request/response, and MCP clients send one call at a time. Refusing the
	// shape is a smaller change than trying to bound its concurrency.
	if (Array.isArray(body)) {
		return json(
			{ error: "Batched JSON-RPC requests are not supported. Send one call." },
			400,
		);
	}

	// Authenticate BEFORE building the server, so an invalid credential never
	// reaches the protocol layer and never learns which tools exist. For a
	// personal token this also stamps `last_used_at`; every tool authenticates
	// again for itself, which is a few hundred microseconds and keeps each
	// tool's check its own. An OAuth grant is already verified by now, so this
	// is where a token for a since-deleted user is refused.
	try {
		await authenticateToken(ctx);
	} catch (err) {
		if (err instanceof McpUnauthorizedError) {
			return unauthorizedResponse(err.message);
		}
		console.error("[mcp] authentication failed:", err);
		return json({ error: "Could not verify that token." }, 500);
	}

	const server = buildServer(ctx);
	const transport = new WebStandardStreamableHTTPServerTransport({
		// Stateless: no session storage, and each POST stands alone.
		sessionIdGenerator: undefined,
		// Plain JSON responses rather than the default SSE stream. Every tool here
		// is simple request/response — nothing streams, nothing sends
		// notifications — so a stream buys nothing and costs something: an SSE
		// body held open through Nitro and Railway's proxy is a buffering and
		// idle-timeout problem that a single JSON response does not have. The
		// Streamable HTTP spec allows either, and clients negotiate.
		enableJsonResponse: true,
	});

	try {
		await server.connect(transport);
		// The body is already consumed above (for the size cap), so hand the
		// parsed value over rather than letting the transport re-read the stream.
		return await transport.handleRequest(request, { parsedBody: body });
	} catch (err) {
		console.error("[mcp] transport error:", err);
		return json({ error: "Could not handle that request." }, 500);
	} finally {
		// Release this request's server and transport. Stateless mode keeps no
		// session, so there is nothing a later request could want from them.
		await transport.close().catch(() => {});
		await server.close().catch(() => {});
	}
}

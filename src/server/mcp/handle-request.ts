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
 * over the moment someone uses it for real. `mcp-transport.integration.test.ts`
 * makes two sequential calls against one process for exactly this reason.
 *
 * Constructing a server per request is cheap — it is object graph assembly, no
 * I/O.
 *
 * ## Authentication happens here, before any tool runs
 *
 * The token is read off the `Authorization` header and passed down as opaque
 * context; each tool resolves it itself (`authz-logic`). A missing, unknown or
 * revoked token is a 401 at the HTTP layer rather than a tool error, because a
 * caller with no valid credential should not learn which tools exist.
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
import { parseBearerToken } from "#/server/pathways-ingest-logic";
import { authenticateToken, McpUnauthorizedError } from "./authz-logic";
import { McpError, toMcpError } from "./errors";
import { MCP_TOOLS } from "./tools";

/**
 * 1 MB, checked BEFORE parsing and before the token is trusted — the shape
 * `/api/pathways/ingest` already uses. A 100-entry guest-book page is a few KB.
 */
const MAX_BODY_BYTES = 1_000_000;

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

/** Build a server with every registered tool bound to this request's token. */
function buildServer(rawToken: string | null): McpServer {
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
					const result = await tool.handler(args ?? {}, { rawToken });
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

	// Reject an oversized body before reading it. Declared content-length first
	// (cheap), then the actual text, to cover a chunked body that declares none.
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) {
		return json({ error: "Body too large." }, 413);
	}
	let text: string;
	try {
		text = await request.text();
	} catch {
		return json({ error: "Could not read request body." }, 400);
	}
	if (text.length > MAX_BODY_BYTES) {
		return json({ error: "Body too large." }, 413);
	}
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return json({ error: "Body must be JSON." }, 400);
	}

	// Authenticate BEFORE building the server, so an invalid credential never
	// reaches the protocol layer and never learns which tools exist. This also
	// stamps `last_used_at`; every tool authenticates again for itself, which is
	// a few hundred microseconds and keeps each tool's check its own.
	try {
		await authenticateToken(rawToken);
	} catch (err) {
		if (err instanceof McpUnauthorizedError) {
			return json({ error: err.message }, 401);
		}
		console.error("[mcp] authentication failed:", err);
		return json({ error: "Could not verify that token." }, 500);
	}

	const server = buildServer(rawToken);
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

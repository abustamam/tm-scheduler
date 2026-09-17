/**
 * What an MCP tool IS in this codebase (#773).
 *
 * A tool is a plain object — a name, an MCP config (title, description, zod
 * input shape), and a handler that takes the parsed input plus the request's
 * bearer token. It is deliberately NOT a call to `server.registerTool` at module
 * scope: the route builds a fresh `McpServer` per request (D1), so the
 * definitions have to be data that a new server can be built FROM, and a
 * definition that is data is also a definition a guard test can walk, import
 * and inspect.
 *
 * The handler receives the raw token rather than an already-resolved identity,
 * because each tool authorizes for ITSELF against the club its own input names
 * — `whoami` has no club, `list_meetings` has a `clubId`, `get_agenda` derives
 * one from a meeting. A middleware that resolved "the" club before dispatch
 * would have to guess which of those shapes it was looking at.
 */
import type { ZodRawShape } from "zod";

/** Per-request state a tool handler may use. Just the credential, for now. */
export interface McpToolContext {
	/** The raw `Authorization: Bearer …` value. Every tool authorizes with it. */
	rawToken: string | null;
}

export interface McpToolDefinition {
	/** The tool name as MCP clients see it, e.g. `record_guest_book`. */
	name: string;
	config: {
		title: string;
		description: string;
		inputSchema?: ZodRawShape;
	};
	/**
	 * Returns anything JSON-serialisable; the transport layer wraps it. Throws
	 * `McpError` for a failure the caller should act on — never a bare string
	 * comparison against some other module's prose (see `errors.ts`).
	 */
	handler: (
		input: Record<string, unknown>,
		ctx: McpToolContext,
	) => Promise<unknown>;
}

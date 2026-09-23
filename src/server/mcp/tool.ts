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
 * The handler receives the CREDENTIAL rather than an already-resolved identity,
 * because each tool authorizes for ITSELF against the club its own input names
 * — `whoami` has no club, `list_meetings` has a `clubId`, `get_agenda` derives
 * one from a meeting. A middleware that resolved "the" club before dispatch
 * would have to guess which of those shapes it was looking at. Tools pass the
 * whole context to `authz-logic` and never branch on which kind it is.
 */
import type { ZodRawShape } from "zod";

/**
 * An OAuth access token that has ALREADY been verified — signature, issuer,
 * audience, expiry — by Better Auth's resource-server handler at the HTTP
 * layer (`oauth-credential.ts`, #843). Only `grantFromClaims`
 * (`oauth-claims.ts`) builds one, and only from claims `requireMcpAuth` has
 * already verified; `handle-request.ts` passes it straight to the tools.
 * Nothing a caller sends reaches these fields any other way.
 */
export interface VerifiedOAuthGrant {
	/** The token's `sub`: the GavelUp user it was issued to. */
	userId: string;
	/** The OAuth client that holds it (`client_id` / `azp`). */
	clientId: string;
	/** The token's `jti`. */
	tokenId: string;
}

/**
 * Per-request state a tool handler may use: the credential, in one of two
 * kinds (#843).
 *
 * - `rawToken` — a personal `tmk_` token straight off the `Authorization`
 *   header, resolved against `api_tokens` by `authz-logic` on every call.
 * - `oauthGrant` — a claude.ai access token, verified before any tool ran.
 */
export type McpToolContext =
	| { rawToken: string | null }
	| { oauthGrant: VerifiedOAuthGrant };

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

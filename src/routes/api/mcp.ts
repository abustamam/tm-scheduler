import { createFileRoute } from "@tanstack/react-router";
import { handleMcpRequest } from "#/server/mcp/handle-request";

/**
 * POST /api/mcp — MCP over Streamable HTTP, stateless (#773 / #771).
 *
 * Auth is a per-USER Bearer token (`Authorization: Bearer tmk_…`), never a
 * session cookie. The token identifies a person; each tool then resolves that
 * person's membership in whichever club its input names, so every write is
 * credited to a real `actor_member_id`. Contrast `/api/pathways/ingest`, whose
 * `gup_` token IS a club and credits its writes to nobody.
 *
 * Bearer-only is also the CSRF posture: a cross-site POST carries no ambient
 * credential, so there is nothing to forge. Nothing on this path reads a cookie,
 * and `mcp-authz.guard.test.ts` holds that across the whole `src/server/mcp/`
 * tree as well as this file.
 *
 * NO CORS headers, unlike ingest: the clients here are not browsers, so there is
 * no preflight to answer and no origin to grant.
 *
 * The body lives in `src/server/mcp/handle-request.ts` rather than here because
 * a `createFileRoute` handler body cannot be reached from a test (#544), and
 * this is a route whose behaviour has to be tested rather than asserted.
 *
 * Connect with:
 *   claude mcp add --transport http gavelup https://<host>/api/mcp \
 *     --header "Authorization: Bearer tmk_..."
 */
export const Route = createFileRoute("/api/mcp")({
	server: {
		handlers: {
			POST: ({ request }) => handleMcpRequest(request),
		},
	},
});

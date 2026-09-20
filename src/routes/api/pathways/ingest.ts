import { createFileRoute } from "@tanstack/react-router";
import {
	handlePathwaysIngestPreflight,
	handlePathwaysIngestRequest,
} from "#/server/pathways-ingest-request";

/**
 * POST /api/pathways/ingest — the Pathways auto-sync extension (#107) posts here.
 *
 * The body lives in `src/server/pathways-ingest-request.ts` rather than here,
 * for the same reason `/api/mcp`'s does: a `createFileRoute` handler body cannot
 * be reached from a test (#544), and this endpoint takes no credential before it
 * reads a request body, so what it does with an oversized one has to be testable.
 */
export const Route = createFileRoute("/api/pathways/ingest")({
	server: {
		handlers: {
			// CORS preflight.
			OPTIONS: () => handlePathwaysIngestPreflight(),
			POST: ({ request }) => handlePathwaysIngestRequest(request),
		},
	},
});

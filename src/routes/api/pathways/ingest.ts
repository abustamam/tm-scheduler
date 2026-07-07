import { createFileRoute } from "@tanstack/react-router";
import { IngestError, ingestForToken } from "#/server/pathways-ingest-logic";

/**
 * POST /api/pathways/ingest — the Pathways auto-sync extension (#107) posts here.
 * Auth is a per-club Bearer token (Authorization: Bearer gup_…), NOT a session:
 * the token encodes the club. Body: { basecampClubGuid, pages: BcmProgressPage[] }.
 * Returns the SyncResult (+ optional `warning`) as JSON.
 */
export const Route = createFileRoute("/api/pathways/ingest")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const header = request.headers.get("authorization") ?? "";
				const token = header.startsWith("Bearer ")
					? header.slice("Bearer ".length)
					: null;

				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json(
						{ error: "Body must be JSON." },
						{ status: 400 },
					);
				}

				try {
					const result = await ingestForToken(token, body);
					return Response.json(result, { status: 200 });
				} catch (err) {
					if (err instanceof IngestError) {
						return Response.json(
							{ error: err.message },
							{ status: err.status },
						);
					}
					return Response.json({ error: "Sync failed." }, { status: 500 });
				}
			},
		},
	},
});

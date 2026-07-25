import { createFileRoute } from "@tanstack/react-router";
import { roleSheetByKey } from "#/data/role-sheets";
import { getMeetingClubId } from "#/server/minutes-logic";
import { renderRoleSheetPdf } from "#/server/role-sheets-pdf-logic";

/**
 * GET /api/meetings/$id/role-sheets/$sheet/pdf — download a meeting-aware role
 * sheet, pre-filled with the club name, meeting date, and scheduled speakers
 * (#311). Generated server-side via `@react-pdf/renderer` (no Chromium),
 * mirroring the minutes-PDF route. PUBLIC (#317/#365): the sheet contains only
 * what the public agenda already shows — club, date, scheduled speaker names,
 * and the Word of the Day — no member contact or private minutes, so anyone
 * viewing the canonical meeting page can download it. Unknown sheet/meeting → 404.
 */
export const Route = createFileRoute(
	"/api/meetings/$id/role-sheets/$sheet/pdf",
)({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const meetingId = params.id;
				const info = roleSheetByKey(params.sheet);
				if (!info) {
					return new Response("Unknown role sheet.", { status: 404 });
				}

				// Validate the meeting exists (clean 404 instead of a render 500).
				try {
					await getMeetingClubId(meetingId);
				} catch {
					return new Response("Meeting not found.", { status: 404 });
				}

				const { bytes, clubName, date } = await renderRoleSheetPdf(
					meetingId,
					info.key,
				);

				// Friendly filename: "<Sheet> - <Club> - <Date>.pdf".
				const safe = `${info.title} - ${clubName} - ${date}`
					.replace(/[^\w\-. ]+/g, "")
					.trim();

				return new Response(new Uint8Array(bytes), {
					status: 200,
					headers: {
						"content-type": "application/pdf",
						"content-disposition": `attachment; filename="${safe}.pdf"`,
						"cache-control": "no-store",
					},
				});
			},
		},
	},
});

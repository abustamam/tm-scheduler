import { createFileRoute } from "@tanstack/react-router";
import { roleSheetByKey } from "#/data/role-sheets";
import { getMembership, getSessionUser } from "#/server/guards";
import { getMeetingClubId } from "#/server/minutes-logic";
import { renderRoleSheetPdf } from "#/server/role-sheets-pdf-logic";

/**
 * GET /api/meetings/$id/role-sheets/$sheet/pdf — download a meeting-aware role
 * sheet, pre-filled with the club name, meeting date, and scheduled speakers
 * (#311). Generated server-side via `@react-pdf/renderer` (no Chromium),
 * mirroring the minutes-PDF route. Any signed-in member of the club may
 * download (prep material, not private minutes): anon → 401, non-member → 403.
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

				const sessionUser = await getSessionUser();
				if (!sessionUser) {
					return new Response("Sign in required.", { status: 401 });
				}

				let clubId: string;
				try {
					clubId = await getMeetingClubId(meetingId);
				} catch {
					return new Response("Meeting not found.", { status: 404 });
				}

				const membership = await getMembership(sessionUser.id, clubId);
				if (!membership) {
					return new Response("Not a member of this club.", { status: 403 });
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

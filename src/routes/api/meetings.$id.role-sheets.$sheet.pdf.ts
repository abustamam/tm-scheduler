import { createFileRoute } from "@tanstack/react-router";
import { roleSheetByKey } from "#/data/role-sheets";
import { isReadableClub } from "#/server/club-logo-logic";
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

				// Validate the meeting exists (clean 404 instead of a render 500),
				// and that its club is one a public caller may read at all.
				//
				// The archive check is on the WHOLE sheet, not just its logo. An
				// earlier pass gated only `loadRoleSheetLogo`, which meant archiving
				// a club — the documented takedown lever — removed its crest from
				// this PDF and left the club name, meeting date, Word of the Day and
				// every scheduled speaker's name still being served to anonymous
				// callers. `src/lib/club-archive.ts` states the repo-wide rule:
				// every public no-auth club loader must treat an archived club as
				// not-found. This is such a loader.
				let clubId: string;
				try {
					clubId = await getMeetingClubId(meetingId);
				} catch {
					return new Response("Meeting not found.", { status: 404 });
				}
				if (!(await isReadableClub(clubId))) {
					return new Response("Meeting not found.", { status: 404 });
				}

				// A render failure is a 500 either way, but an unshaped framework
				// stack trace on a public route is not the 500 we want.
				let rendered: Awaited<ReturnType<typeof renderRoleSheetPdf>>;
				try {
					rendered = await renderRoleSheetPdf(meetingId, info.key);
				} catch (err) {
					console.error("role-sheet PDF render failed", { meetingId, err });
					return new Response("Could not build that role sheet.", {
						status: 500,
					});
				}
				const { bytes, clubName, date } = rendered;

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

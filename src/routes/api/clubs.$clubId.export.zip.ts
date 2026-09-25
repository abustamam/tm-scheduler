import { createFileRoute } from "@tanstack/react-router";
import {
	buildClubExportZip,
	clubExportFilename,
	loadClubExport,
} from "#/server/club-export-logic";
import { isReadableClub } from "#/server/club-readable-logic";
import { getSessionUser, requireClubRole } from "#/server/guards";

/**
 * GET /api/clubs/$clubId/export/zip — a club admin downloads the club's data as
 * one `.zip` of CSVs (#915). Linked from Club settings ("Your club's data") and
 * the roster ("Export club data").
 *
 * Same shape as the minutes PDF (`meetings.$id.minutes.pdf.ts`): a plain authed
 * GET, so a bookmarked URL arrives with only a session cookie and no router.
 *
 * - 401 without a session;
 * - 404 for an unknown, malformed or ARCHIVED club (#560's takedown: this route
 *   resolves the club itself, so it never passes through a gate's
 *   `assertClubNotArchived` and must refuse on its own);
 * - 403 unless the caller is an admin of THIS club, by `requireClubRole(…,
 *   ["admin"])` — the one statement of "club admin" every admin server fn uses,
 *   so it admits exactly who Club settings admits (a `club_role = admin`
 *   membership, an elected officer with an open term, a read-write
 *   impersonating superadmin) and nobody the page would show a dead link to.
 *   An active membership is required; a lapsed admin is refused.
 *
 * The response is every member's and guest's contact details, so it is never
 * cached (`no-store`).
 */
export const Route = createFileRoute("/api/clubs/$clubId/export/zip")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const { clubId } = params;
				const sessionUser = await getSessionUser();
				if (!sessionUser) {
					return new Response("Sign in required.", { status: 401 });
				}
				if (!(await isReadableClub(clubId))) {
					return new Response("Club not found.", { status: 404 });
				}
				try {
					await requireClubRole(sessionUser.id, clubId, ["admin"]);
				} catch {
					return new Response("Only club admins can export club data.", {
						status: 403,
					});
				}

				const data = await loadClubExport(clubId);
				if (!data) {
					return new Response("Club not found.", { status: 404 });
				}
				const now = new Date();
				const zip = buildClubExportZip(data, now);
				const filename = clubExportFilename(
					data.club.slug,
					data.club.timezone,
					now,
				);

				return new Response(new Uint8Array(zip), {
					status: 200,
					headers: {
						"content-type": "application/zip",
						"content-disposition": `attachment; filename="${filename}"`,
						"cache-control": "no-store",
					},
				});
			},
		},
	},
});

import { createFileRoute } from "@tanstack/react-router";
import { db } from "#/db";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { logActivity } from "#/server/activity";
import {
	beginClubExport,
	buildClubExportZip,
	clubExportFilename,
	loadClubExport,
} from "#/server/club-export-logic";
import { isReadableClub } from "#/server/club-readable-logic";
import {
	getSessionUser,
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	requireClubRole,
} from "#/server/guards";

/** `requireClubRole`'s refusals: not a member, or a member without the role. */
const FORBIDDEN_MESSAGES = new Set([
	NOT_A_MEMBER_MESSAGE,
	NO_PERMISSION_MESSAGE,
]);
/** Its not-found answers, for a club archived or deleted mid-request. */
const GONE_MESSAGES = new Set([CLUB_ARCHIVED_MESSAGE, "Club not found."]);

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
 * - 429 while another export of the same club is still being built
 *   (`beginClubExport`).
 *
 * The response is every member's and guest's contact details, so it is never
 * cached (`no-store`), and every download writes a `club_data_exported`
 * activity row naming who took it.
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
				let actorMemberId: string | null;
				try {
					const membership = await requireClubRole(sessionUser.id, clubId, [
						"admin",
					]);
					actorMemberId = membership.id;
				} catch (err) {
					// Only an AUTHORIZATION answer becomes a 403. Anything else — a
					// dropped connection, a bug — propagates as a 500 and is logged,
					// instead of telling an admin they lack permission when the
					// database is down.
					const message = err instanceof Error ? err.message : "";
					if (FORBIDDEN_MESSAGES.has(message)) {
						return new Response("Only club admins can export club data.", {
							status: 403,
						});
					}
					// Archived or deleted between `isReadableClub` and here.
					if (GONE_MESSAGES.has(message)) {
						return new Response("Club not found.", { status: 404 });
					}
					console.error("[club-export] authorization failed", err);
					throw err;
				}

				const release = beginClubExport(clubId);
				if (!release) {
					return new Response(
						"An export of this club is already being prepared. Try again in a moment.",
						{ status: 429, headers: { "retry-after": "10" } },
					);
				}
				try {
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
					// Recorded before the bytes leave, and a failure to record fails
					// the download: an export nobody can see was taken is the thing
					// this row exists to rule out. `logActivity` stamps
					// `impersonated_by` itself when a read-write impersonation granted
					// the request (the guard marked it).
					await logActivity(db, {
						clubId: data.club.id,
						actorMemberId,
						action: "club_data_exported",
						targetType: "club",
						targetId: data.club.id,
						detail: { filename },
					});
					return new Response(new Uint8Array(zip), {
						status: 200,
						headers: {
							"content-type": "application/zip",
							"content-disposition": `attachment; filename="${filename}"`,
							"cache-control": "no-store",
						},
					});
				} catch (err) {
					console.error("[club-export] export failed", err);
					throw err;
				} finally {
					release();
				}
			},
		},
	},
});

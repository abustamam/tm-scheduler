import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import { cap } from "#/lib/cap";
import { formatShortDate } from "#/lib/format";
import { MINUTES_RENDER_CAPS } from "#/lib/minutes-render-caps";
import { isReadableClub } from "#/server/club-readable-logic";
import { getMembership, getSessionUser } from "#/server/guards";
import { getMeetingClubId, getMeetingStatus } from "#/server/minutes-logic";
import { renderMinutesPdf } from "#/server/minutes-pdf-logic";

/**
 * GET /api/meetings/$id/minutes/pdf — download a meeting's minutes as a PDF
 * (ADR-0014 / #152). Same visibility as the on-screen Minutes section: club
 * admins always; members only once the meeting is `completed`. Non-members get
 * 403. Generated server-side via `@react-pdf/renderer` (no Chromium).
 */
export const Route = createFileRoute("/api/meetings/$id/minutes/pdf")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const meetingId = params.id;
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
				// Archive takedown (#560). This route resolves membership itself rather
				// than through a `require*` gate, so it never reaches the gates'
				// `assertClubNotArchived` — and it is a plain authed GET URL, so a
				// pre-takedown bookmark works with only a session cookie and no router.
				// Answers not-found, matching the sibling role-sheets route beside it.
				if (!(await isReadableClub(clubId))) {
					return new Response("Meeting not found.", { status: 404 });
				}
				const membership = await getMembership(sessionUser.id, clubId);
				// `status` matters, not just presence: a LAPSED member of the club could
				// otherwise still download the minutes.
				if (!membership || membership.status !== "active") {
					return new Response("Not a member of this club.", { status: 403 });
				}
				const status = await getMeetingStatus(meetingId);
				const canDownload =
					membership.clubRole === "admin" || status === "completed";
				if (!canDownload) {
					return new Response("Minutes aren't available yet.", { status: 403 });
				}

				const pdf = await renderMinutesPdf(meetingId);

				// Build a friendly filename: "Minutes - <club> - <date>.pdf".
				const [row] = await db
					.select({
						name: clubs.name,
						scheduledAt: meetings.scheduledAt,
						timezone: clubs.timezone,
					})
					.from(meetings)
					.innerJoin(clubs, eq(clubs.id, meetings.clubId))
					.where(eq(meetings.id, meetingId))
					.limit(1);
				const date = row
					? formatShortDate(row.scheduledAt, row.timezone)
					: "meeting";
				// CAPPED before it reaches the header, for the same reason
				// `renderRoleSheetPdf` caps its own filename (#522). This value
				// never enters the PDF, so the render caps do not cover it, and
				// `clubs.name` has no write-side max. Uncapped, a megabyte club
				// name becomes a megabyte response header — Node emits it and
				// every proxy in front of it rejects the response at 8-32KB, so
				// the member gets a 502 with nothing logged server-side. The
				// regex would also scan the whole megabyte per request.
				const safe = `Minutes - ${cap(
					row?.name ?? "Club",
					MINUTES_RENDER_CAPS.club,
				)} - ${date}`
					.replace(/[^\w\-. ]+/g, "")
					.trim();

				return new Response(new Uint8Array(pdf), {
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

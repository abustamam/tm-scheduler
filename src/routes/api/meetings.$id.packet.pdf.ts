import { createFileRoute } from "@tanstack/react-router";
import type { PacketPieceKey } from "#/lib/meeting-packet";
import {
	DEFAULT_WORD_POSTER_COPIES,
	PACKET_PIECES,
} from "#/lib/meeting-packet";
import { isReadableClub } from "#/server/club-readable-logic";
import { getMeetingClubId } from "#/server/minutes-logic";
import { renderPacketPdf } from "#/server/packet-pdf-logic";

/**
 * GET /api/meetings/$id/packet.pdf — the whole night's paper in one file (#589).
 *
 * `?piece=timer&piece=grammarian&…&copies=3`. Repeated `piece` params rather
 * than a comma list so a stale bookmark with an unknown piece degrades to
 * printing the rest, and so the URL says what it contains when someone reads it
 * out of a browser history.
 *
 * PUBLIC, like the per-sheet route it sits beside: every page in this packet is
 * already downloadable one at a time from there, and the poster is already a
 * public HTML page — this staples together what was public already. The archive
 * gate applies for the same reason it applies there (#544): a taken-down club's
 * meeting must answer as not-found here too, and that check is on the WHOLE
 * packet rather than on its logo.
 */
export const Route = createFileRoute("/api/meetings/$id/packet/pdf")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const meetingId = params.id;
				const url = new URL(request.url);

				// A closed set, so an unknown `?piece=` is dropped rather than
				// reaching the renderer. The list is the same one the picker renders.
				const known = new Set(PACKET_PIECES.map((p) => p.key as string));
				const selection = url.searchParams
					.getAll("piece")
					.filter((p) => known.has(p)) as PacketPieceKey[];

				const raw = url.searchParams.get("copies");
				const copies =
					raw == null ? DEFAULT_WORD_POSTER_COPIES : Number.parseInt(raw, 10);

				if (selection.length === 0) {
					return new Response("Nothing selected for the packet.", {
						status: 400,
					});
				}

				let clubId: string;
				try {
					clubId = await getMeetingClubId(meetingId);
				} catch {
					return new Response("Meeting not found.", { status: 404 });
				}
				if (!(await isReadableClub(clubId))) {
					return new Response("Meeting not found.", { status: 404 });
				}

				let rendered: Awaited<ReturnType<typeof renderPacketPdf>>;
				try {
					rendered = await renderPacketPdf(meetingId, selection, copies);
				} catch (err) {
					// An unshaped framework stack trace on a public route is not the
					// 500 we want, and the page-ceiling throw lands here too.
					console.error("packet PDF render failed", { meetingId, err });
					return new Response("Could not build that packet.", { status: 500 });
				}
				if (!rendered) {
					return new Response("Meeting not found.", { status: 404 });
				}

				const { bytes, clubName, date } = rendered;
				const safe = `Meeting packet - ${clubName} - ${date}`
					.replace(/[^\w\-. ]+/g, "")
					.trim();

				return new Response(new Uint8Array(bytes), {
					headers: {
						"content-type": "application/pdf",
						"content-disposition": `attachment; filename="${safe}.pdf"`,
						// Rendered per request from live meeting data, exactly like the
						// per-sheet route. A cached packet is a packet that keeps the
						// last meeting's Word of the Day.
						"cache-control": "no-store",
					},
				});
			},
		},
	},
});

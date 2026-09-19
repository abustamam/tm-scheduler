/**
 * The printed meeting packet (#589): one PDF holding whichever sheets a club
 * wants for the night, plus however many copies of the Word of the Day poster
 * it needs for its room.
 *
 * Printing for a meeting was one download per role sheet plus a separate browser
 * print of the poster — a trip per piece — and missing one meant a functionary
 * sitting down with no sheet.
 *
 * ASSEMBLED, NOT CONCATENATED. `@react-pdf/renderer` documents cannot nest, so
 * this builds ONE `Document` from pages: `buildRoleSheetPage` unwraps each
 * sheet's page and `buildWordPosterPage` produces the poster's, rather than
 * rendering several PDFs and merging bytes (which would need a merge
 * dependency) or re-implementing every sheet's layout a second time (which is
 * the drift this repo has already paid for once — the print CSS was three
 * divergent copies until v1.8.4.0).
 *
 * Server-only: touches `#/db` and react-pdf, so no client route may import it.
 * The client picker reads `#/lib/meeting-packet`, which is pure.
 */
import { Document, renderToBuffer } from "@react-pdf/renderer";
import { createElement as h } from "react";
import {
	clampPosterCopies,
	PACKET_PIECES,
	type PacketPieceKey,
	packetPageCount,
} from "#/lib/meeting-packet";
import { isReadableClubForMeeting } from "#/server/club-readable-logic";
import {
	buildRoleSheetPage,
	cap,
	RENDER_CAPS,
} from "#/server/role-sheet-layout";
import { loadRoleSheetFill } from "#/server/role-sheets-pdf-logic";
import { buildWordPosterPage } from "#/server/word-poster-layout";

/**
 * WHAT BOUNDS THIS RENDER, since every page is laid out synchronously by
 * react-pdf inside the one Node process serving everything else (ADR-0007) and
 * the selection arrives from a query string.
 *
 * The bound is arithmetic, not a check: `clampPosterCopies` caps the poster at
 * `WORD_POSTER_COPIES.max` (12) and the pieces are a closed set of six sheets,
 * so a packet cannot exceed 18 pages however hostile the query string. An
 * explicit `MAX_PACKET_PAGES` guard was written here first and removed — it was
 * unreachable, which a test proved by failing to trip it, and an unreachable
 * guard is worse than none: it reads as the thing keeping the render bounded
 * while the clamp is doing the work, so raising the clamp later would look safe.
 */

export interface RenderedPacket {
	bytes: Uint8Array;
	clubName: string;
	date: string;
	pages: number;
}

/**
 * Render the packet.
 *
 * PUBLIC, like the role-sheet route it sits beside: every page in it is already
 * downloadable one at a time from that route, and the poster is already a
 * public HTML page. So this adds no data to the public surface — it staples
 * together what was public already. The archive gate is applied for the same
 * reason (#544): a taken-down club's meeting must answer as absent here too.
 */
export async function renderPacketPdf(
	meetingId: string,
	selection: readonly PacketPieceKey[],
	posterCopies: number,
): Promise<RenderedPacket | null> {
	if (!(await isReadableClubForMeeting(meetingId))) return null;

	const copies = clampPosterCopies(posterCopies);
	// Deduped and re-ordered to the canonical order, so `?piece=timer&piece=timer`
	// cannot print the same sheet twice and the packet's page order does not
	// depend on the order of the query string.
	//
	// READ FROM `PACKET_PIECES`, NEVER RESTATED. A hand-written copy of that list
	// sat here and was missing `toastmaster` (#719), and every layer that could
	// have caught it was pointing the wrong way: the `as PacketPieceKey[]` cast on
	// the literal asserted membership, which is precisely what defeats the
	// exhaustiveness a widened union would otherwise have failed on, and
	// `packetPageCount` runs BELOW this filter, so it counted what survived rather
	// than what was asked for. The picker ticked the Toastmaster's script, the
	// route accepted `?piece=toastmaster`, and a packet of exactly that sheet
	// rendered zero pages and answered 404 with every gate green. One list, which
	// is the same argument this module's docblock makes for reading the caps from
	// `lib/` rather than assuming them here.
	const wanted = new Set(selection);
	const sheetKeys = PACKET_PIECES.map((p) => p.key).filter((k) =>
		wanted.has(k),
	);

	const pages = packetPageCount(sheetKeys, copies);
	if (pages === 0) return null;

	const fill = await loadRoleSheetFill(meetingId);

	const children = [];
	if (wanted.has("word-poster")) {
		for (let i = 0; i < copies; i++) {
			children.push(
				buildWordPosterPage(
					{
						word: fill.wod?.word ?? "",
						definition: fill.wod?.note ?? null,
						example: null,
						clubName: fill.clubName,
						dateLong: fill.date,
						logoDataUri: fill.logoDataUri,
					},
					`poster-${i}`,
				),
			);
		}
	}
	for (const key of sheetKeys) {
		// Narrowed, not cast: `PacketPieceKey` is `RoleSheetKey | "word-poster"`,
		// so taking the poster out here leaves a key the builder accepts without an
		// assertion — and an assertion is what hid the missing sheet above.
		//
		// An unknown key cannot reach this loop, so there is no lookup guarding it:
		// the filter above admits only keys the registry lists, and the route drops
		// an unknown `?piece=` before that. A guard here would be unreachable, and
		// an unreachable guard reads as the thing keeping a stale bookmark safe
		// while something else does the work — the same trap as the page ceiling
		// this file deliberately does not have.
		if (key === "word-poster") continue;
		children.push(buildRoleSheetPage(key, fill, `sheet-${key}`));
	}

	const buf = await renderToBuffer(
		h(Document, {}, ...children) as Parameters<typeof renderToBuffer>[0],
	);
	return {
		bytes: new Uint8Array(buf),
		// Capped for the same reason the role-sheet route caps them: these reach
		// the `content-disposition` filename rather than the PDF, so they bypass
		// the layout's own bounds.
		clubName: cap(fill.clubName, RENDER_CAPS.club),
		date: cap(fill.date, RENDER_CAPS.date),
		pages,
	};
}

// Server-side, meeting-aware role-sheet PDF generation (#311) via
// `@react-pdf/renderer` — mirrors the minutes-PDF path (`minutes-pdf-logic.ts`):
// a pure-JS renderer with no headless browser, so it fits the `node:22-slim`
// Railway image. Server-only (touches `#/db`); never imported by a client route
// (the client menu imports the client-safe registry in `#/data/role-sheets`).
import { renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { clubLogos, clubs, meetings } from "#/db/schema";
import { formatShortDate } from "#/lib/format";
import { isDecodeSafe } from "#/server/club-logo-logic";
import { isReadableClub } from "#/server/club-readable-logic";
import {
	loadMinutesProgram,
	type MinutesProgramRow,
} from "#/server/minutes-logic";
import {
	buildRoleSheetDoc,
	cap,
	RENDER_CAPS,
	type RoleSheetFill,
	type RoleSheetKey,
} from "#/server/role-sheet-layout";

/**
 * Display-ready labels for the prepared speakers in a meeting's program, in
 * agenda order: the assignee's name, with the speech title in quotes when set.
 * Only assigned speaker slots are included — open slots (no assignee) are
 * dropped so their rows stay blank on the sheet. Pure (no db) so it is unit
 * tested directly.
 */
export function speakerLabels(
	program: Pick<
		MinutesProgramRow,
		"category" | "assigneeName" | "speechTitle"
	>[],
): string[] {
	return program
		.filter((p) => p.category === "speaker" && p.assigneeName)
		.map((p) =>
			p.speechTitle
				? `${p.assigneeName} — "${p.speechTitle}"`
				: (p.assigneeName as string),
		);
}

/** A rendered role sheet plus the club/date labels used for its filename. */
export interface RenderedRoleSheet {
	bytes: Uint8Array;
	clubName: string;
	/** Short, club-timezone meeting date (e.g. "Jul 22"). */
	date: string;
}

/**
 * The meeting's club logo as a base64 data URI, or null.
 *
 * Joins through `meetings` so the caller needs only a meeting id, and reads
 * `club_logos` scoped to that meeting's own club — the same per-club scoping
 * every other logo read uses (ADR-0024 constraint 2). Returns null rather than
 * throwing: a missing logo is the common case, not an error.
 *
 * Two gates run after the read, and both are load-bearing:
 *
 *  · `isReadableClub` — the SAME gate every public club reader uses, not a
 *    reimplementation. Archiving a club is this feature's takedown lever
 *    (ADR-0024 constraint 4), and this route is public, so without it an
 *    archived club's logo kept shipping inside downloadable PDFs and the lever
 *    did nothing. That is the exact defect #495's review caught on
 *    `loadClubLogoMeta`; it came back here because this path was written fresh
 *    and forgot it, which is precisely why `isReadableClub` is shared rather
 *    than copied.
 *
 *  · `isDecodeSafe` — react-pdf decodes this data URI inside the Node process,
 *    so an over-large image is an availability problem on a public endpoint
 *    (see `MAX_LOGO_DIMENSION`). The upload gate stops new ones; this stops
 *    rows that predate the cap. Dropping the logo is the right failure: a role
 *    sheet without a logo still prints.
 */
export async function loadRoleSheetLogo(
	meetingId: string,
): Promise<string | null> {
	const [row] = await db
		.select({
			clubId: meetings.clubId,
			bytes: clubLogos.bytes,
			mime: clubLogos.mime,
		})
		.from(meetings)
		.innerJoin(clubLogos, eq(clubLogos.clubId, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) return null;
	if (!(await isReadableClub(row.clubId))) return null;
	if (!isDecodeSafe(row.bytes, row.mime)) {
		// Loud, because it is otherwise invisible: the club sees its logo on all
		// four HTML surfaces and silently missing from this PDF, and an operator
		// has no signal at all. This is also the only observable a genuinely
		// malformed stored image would produce.
		console.warn("club logo skipped as unsafe to decode", {
			clubId: row.clubId,
			mime: row.mime,
			bytes: row.bytes.length,
		});
		return null;
	}
	return `data:${row.mime};base64,${row.bytes.toString("base64")}`;
}

/** Build the per-meeting fill context (club, date, prepared speakers, WOD). */
async function loadRoleSheetFill(
	meetingId: string,
): Promise<RoleSheetFill & { clubName: string }> {
	// All three reads key off `meetingId` alone and none feeds another, so they
	// go out together: this route renders a PDF on every request (`no-store`),
	// and three sequential round-trips is three times the latency floor for no
	// reason.
	const [[row], program, logoDataUri] = await Promise.all([
		db
			.select({
				clubName: clubs.name,
				scheduledAt: meetings.scheduledAt,
				timezone: clubs.timezone,
				wordOfTheDay: meetings.wordOfTheDay,
				wodDefinition: meetings.wodDefinition,
			})
			.from(meetings)
			.innerJoin(clubs, eq(clubs.id, meetings.clubId))
			.where(eq(meetings.id, meetingId))
			.limit(1),
		// Prepared speakers in agenda order, with their speech title when set.
		// Only assigned speaker slots are pre-filled; open slots leave blank rows.
		loadMinutesProgram(meetingId),
		// Same non-fatal posture as every other surface: a logo that fails to
		// load must never cost someone their role sheet. The `.catch` is what
		// implements that — without it this comment was aspirational, since a
		// rejection here rejects the whole `Promise.all` and takes the PDF with
		// it. Every route loader that reads the logo has the same guard.
		loadRoleSheetLogo(meetingId).catch(() => null),
	]);
	if (!row) throw new Error(`meeting ${meetingId} not found`);

	const speakers = speakerLabels(program);

	const date = formatShortDate(row.scheduledAt, row.timezone);
	const wod = row.wordOfTheDay
		? { word: row.wordOfTheDay, note: row.wodDefinition ?? undefined }
		: undefined;

	return {
		clubName: row.clubName,
		club: row.clubName,
		date,
		speakers,
		wod,
		logoDataUri,
	};
}

/**
 * Render a single role sheet for a meeting, pre-filled with the club name,
 * meeting date, prepared speakers, and (for the Grammarian) the Word of the Day.
 * Throws if the meeting does not exist.
 */
export async function renderRoleSheetPdf(
	meetingId: string,
	key: RoleSheetKey,
): Promise<RenderedRoleSheet> {
	const fill = await loadRoleSheetFill(meetingId);
	const buf = await renderToBuffer(
		buildRoleSheetDoc(key, fill) as Parameters<typeof renderToBuffer>[0],
	);
	return {
		bytes: new Uint8Array(buf),
		// CAPPED, like everything else. This value does not go into the PDF — the
		// route interpolates it into the `content-disposition` filename — so it
		// was the one string on this public route that reached a response without
		// passing a bound, and `clubs.name` has no write-side max. That made the
		// claim "the bound lives at the single entry point" false for this
		// consumer, which reads the fill rather than the doc.
		clubName: cap(fill.clubName, RENDER_CAPS.club),
		date: cap(fill.date, RENDER_CAPS.date),
	};
}

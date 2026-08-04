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
import {
	loadMinutesProgram,
	type MinutesProgramRow,
} from "#/server/minutes-logic";
import {
	buildRoleSheetDoc,
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
 */
async function loadRoleSheetLogo(meetingId: string): Promise<string | null> {
	const [row] = await db
		.select({ bytes: clubLogos.bytes, mime: clubLogos.mime })
		.from(meetings)
		.innerJoin(clubLogos, eq(clubLogos.clubId, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) return null;
	return `data:${row.mime};base64,${row.bytes.toString("base64")}`;
}

/** Build the per-meeting fill context (club, date, prepared speakers, WOD). */
async function loadRoleSheetFill(
	meetingId: string,
): Promise<RoleSheetFill & { clubName: string }> {
	const [row] = await db
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
		.limit(1);
	if (!row) throw new Error(`meeting ${meetingId} not found`);

	// Prepared speakers in agenda order, with their speech title when set. Only
	// assigned speaker slots are pre-filled; open slots leave blank rows.
	const program = await loadMinutesProgram(meetingId);
	const speakers = speakerLabels(program);

	// Same non-fatal posture as every other surface: a logo that fails to load
	// must never cost someone their role sheet.
	const logoDataUri = await loadRoleSheetLogo(meetingId);

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
		clubName: fill.clubName,
		date: fill.date,
	};
}

// Server-side, meeting-aware role-sheet PDF generation (#311) via
// `@react-pdf/renderer` — mirrors the minutes-PDF path (`minutes-pdf-logic.ts`):
// a pure-JS renderer with no headless browser, so it fits the `node:22-slim`
// Railway image. Server-only (touches `#/db`); never imported by a client route
// (the client menu imports the client-safe registry in `#/data/role-sheets`).
import { renderToBuffer } from "@react-pdf/renderer";
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
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

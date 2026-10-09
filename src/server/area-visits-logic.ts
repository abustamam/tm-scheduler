// The Area Director's club visits (#1120, part of #1115): record a visit's date
// and round, clear it, read an area's visits, and the one-club summary behind
// the print page. The handlers in `area-visits.ts` hold the gates; this module
// has no session and TRUSTS ITS CALLER, except for the two things it must
// decide itself and does: the re-asked term check inside a write's transaction
// (`requireAreaDirectorTx`), and that a club belongs to the area it was asked
// about.
//
// Plain logic module: no `createServerFn`, never imported by client code.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { areaClubs, areas, clubs, clubVisits, divisions } from "#/db/schema";
import type { AreaHealth } from "#/lib/area-health";
import {
	type AreaClubSummary,
	type AreaVisits,
	type ClubVisits,
	isIsoDate,
	outsideProgramYearMessage,
	programYearIsoWindow,
	VISIT_DATE_INVALID_MESSAGE,
	VISIT_IN_FUTURE_MESSAGE,
	VISIT_ROUND_INVALID_MESSAGE,
	type VisitRound,
} from "#/lib/area-visits";
import { requireAreaDirectorTx } from "./area-guards";
import { loadAreaHealth } from "./area-health-logic";
import { NO_PERMISSION_MESSAGE } from "./guards";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const roundSchema = z.union([z.literal(1), z.literal(2)], {
	message: VISIT_ROUND_INVALID_MESSAGE,
});
const dateSchema = z
	.string({ message: VISIT_DATE_INVALID_MESSAGE })
	.refine(isIsoDate, VISIT_DATE_INVALID_MESSAGE);

export const recordClubVisitSchema = z.object({
	areaClubId: z.string().max(100),
	round: roundSchema,
	visitedOn: dateSchema,
});
export const clearClubVisitSchema = z.object({
	areaClubId: z.string().max(100),
	round: roundSchema,
});
export const areaClubSummarySchema = z.object({
	areaId: z.string().max(100),
	areaClubId: z.string().max(100),
});

const uuid = z.string().uuid();

/**
 * Today's date, as the ISO day it is in `timeZone`. A zone the runtime does not
 * know falls back to UTC rather than failing the write.
 */
export function isoDayIn(now: Date, timeZone: string): string {
	for (const zone of [timeZone, "UTC"]) {
		try {
			// `en-CA` prints the numeric date year-month-day.
			return new Intl.DateTimeFormat("en-CA", {
				timeZone: zone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).format(now);
		} catch {}
	}
	return now.toISOString().slice(0, 10);
}

/**
 * The area an area club sits in, for the handler's fast refusal. An id that is
 * not a uuid and one that names no row are the same refusal as a club the
 * caller may not touch, so the answer does not say which clubs exist.
 */
export async function areaIdOfAreaClub(areaClubId: string): Promise<string> {
	if (!uuid.safeParse(areaClubId).success) {
		throw new Error(NO_PERMISSION_MESSAGE);
	}
	const [row] = await db
		.select({ areaId: areaClubs.areaId })
		.from(areaClubs)
		.where(eq(areaClubs.id, areaClubId));
	if (!row) throw new Error(NO_PERMISSION_MESSAGE);
	return row.areaId;
}

/**
 * Lock the area club's row for the rest of the transaction and re-read where it
 * is: a club removed from the area, or moved, between the handler's lookup and
 * this write is refused rather than written to. Returns what the date rules
 * need: the area's program year and the club's zone.
 */
async function lockAreaClub(
	tx: Tx,
	areaId: string,
	areaClubId: string,
): Promise<{ programYear: number; timeZone: string }> {
	const [row] = await tx
		.select({
			areaId: areaClubs.areaId,
			programYear: divisions.programYear,
			timeZone: clubs.timezone,
		})
		.from(areaClubs)
		.innerJoin(areas, eq(areas.id, areaClubs.areaId))
		.innerJoin(divisions, eq(divisions.id, areas.divisionId))
		.leftJoin(clubs, eq(clubs.id, areaClubs.clubId))
		.where(eq(areaClubs.id, areaClubId))
		.for("share", { of: areaClubs });
	if (!row || row.areaId !== areaId) throw new Error(NO_PERMISSION_MESSAGE);
	// A name-only club, or one whose GavelUp club is gone, has no zone: UTC.
	return { programYear: row.programYear, timeZone: row.timeZone ?? "UTC" };
}

/**
 * Record (or edit) one round's visit: one row per `(area club, round)`. In ONE
 * transaction: the director's term is re-asked under a lock, then the date is
 * checked, then the row is written. `areaId` is the area the handler already
 * authorized for this caller; the club must still be in it.
 */
export async function recordClubVisit(
	userId: string,
	areaId: string,
	input: z.infer<typeof recordClubVisitSchema>,
	now: Date = new Date(),
): Promise<{ round: VisitRound; visitedOn: string }> {
	return db.transaction(async (tx) => {
		await requireAreaDirectorTx(tx, userId, areaId);
		const { programYear, timeZone } = await lockAreaClub(
			tx,
			areaId,
			input.areaClubId,
		);
		if (input.visitedOn > isoDayIn(now, timeZone)) {
			throw new Error(VISIT_IN_FUTURE_MESSAGE);
		}
		const window = programYearIsoWindow(programYear);
		if (input.visitedOn < window.start || input.visitedOn >= window.end) {
			throw new Error(outsideProgramYearMessage(programYear));
		}
		await tx
			.insert(clubVisits)
			.values({
				areaClubId: input.areaClubId,
				round: input.round,
				visitedOn: input.visitedOn,
				recordedBy: userId,
			})
			.onConflictDoUpdate({
				target: [clubVisits.areaClubId, clubVisits.round],
				set: {
					visitedOn: input.visitedOn,
					recordedBy: userId,
					updatedAt: new Date(),
				},
			});
		return { round: input.round, visitedOn: input.visitedOn };
	});
}

/** Clear one round's visit. Clearing a round that was never recorded is not an error. */
export async function clearClubVisit(
	userId: string,
	areaId: string,
	input: z.infer<typeof clearClubVisitSchema>,
): Promise<void> {
	await db.transaction(async (tx) => {
		await requireAreaDirectorTx(tx, userId, areaId);
		await lockAreaClub(tx, areaId, input.areaClubId);
		await tx
			.delete(clubVisits)
			.where(
				and(
					eq(clubVisits.areaClubId, input.areaClubId),
					eq(clubVisits.round, input.round),
				),
			);
	});
}

/** Every recorded visit of the clubs in an area, keyed by area club. */
export async function loadAreaVisits(areaId: string): Promise<AreaVisits> {
	const rows = await db
		.select({
			areaClubId: clubVisits.areaClubId,
			round: clubVisits.round,
			visitedOn: clubVisits.visitedOn,
		})
		.from(clubVisits)
		.innerJoin(areaClubs, eq(areaClubs.id, clubVisits.areaClubId))
		.where(eq(areaClubs.areaId, areaId));
	const visits: AreaVisits = {};
	for (const row of rows) {
		if (row.round !== 1 && row.round !== 2) continue;
		const club: ClubVisits = visits[row.areaClubId] ?? {};
		club[row.round] = row.visitedOn;
		visits[row.areaClubId] = club;
	}
	return visits;
}

/**
 * One club's summary for the print page: its entry from the area's health, the
 * same numbers the area view shows, plus its visits. The club must be in
 * `areaId`: the `WHERE` pairs the two ids, so a director of area A who names
 * area B's club gets the refusal, not B's numbers. The caller has already
 * checked the caller directs `areaId`.
 */
export async function loadAreaClubSummary(
	areaId: string,
	areaClubId: string,
): Promise<AreaClubSummary> {
	if (!uuid.safeParse(areaClubId).success) {
		throw new Error(NO_PERMISSION_MESSAGE);
	}
	const [placed] = await db
		.select({ id: areaClubs.id })
		.from(areaClubs)
		.where(and(eq(areaClubs.id, areaClubId), eq(areaClubs.areaId, areaId)));
	if (!placed) throw new Error(NO_PERMISSION_MESSAGE);
	const health: AreaHealth = await loadAreaHealth(areaId);
	const club = health.clubs.find((c) => c.areaClubId === areaClubId);
	if (!club) throw new Error(NO_PERMISSION_MESSAGE);
	const visits = (await loadAreaVisits(areaId))[areaClubId] ?? {};
	return {
		areaId,
		label: health.label,
		programYear: health.programYear,
		asOf: health.asOf,
		club,
		visits,
	};
}

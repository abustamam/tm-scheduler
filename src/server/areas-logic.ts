// The area hierarchy's DB logic (#1116, part of #1115): districts → divisions →
// areas, the clubs placed in each area, and the Area Director's terms. Every
// caller is a superadmin console server fn in `areas.ts`; this module has no
// session and TRUSTS ITS CALLER, so the gate lives in those handlers and is
// pinned by `areas-authz.guard.test.ts`. Nothing here is imported by a client
// route (the server-modules.guard.test.ts rule), which is why the zod schemas
// the server fns validate with live here beside the logic that relies on them.
//
// The program year lives on `divisions` and nowhere below it. A club sits in
// one area per program year: the cross-table half of that rule cannot be a
// database constraint, so it is a check inside a transaction that first locks
// the `clubs` row (`SELECT … FOR UPDATE`), which is what makes two concurrent
// placements of one club serialize instead of both passing the check.
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	areaClubs,
	areaDirectors,
	areas,
	clubs,
	clubVisits,
	districts,
	divisions,
	user,
} from "#/db/schema";
import { areaLabel } from "#/lib/area-health-fields";
import {
	AREA_CLUB_NAME_MAX,
	AREA_NUMBER_MAX,
	CLUB_HAS_VISITS_MESSAGE,
	DIRECTOR_DISPLAY_NAME_MAX,
	DISTRICT_NUMBER_MAX,
	DIVISION_LETTER_MAX,
} from "#/lib/area-limits";
import { optionalClubNumberSchema } from "#/lib/club-charter";
import { currentProgramYear, programYearLabel } from "#/lib/dcp";
import { normalizedEmail, normalizeEmail } from "./account-link-logic";
import { isCurrentTerm, loadCurrentDirector } from "./area-terms-logic";
import { isSqlState, isUniqueViolation } from "./pg-errors";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

// ---------------------------------------------------------------------------
// Refusals. Exported so the tests and the console compare against the sentence
// the person reads, not a copy of it. No trailing period: they are shown as a
// toast, and the issue words them this way.
// ---------------------------------------------------------------------------

export const CURRENT_TERM_EXISTS_MESSAGE = "End the current term first";
export const NO_CURRENT_TERM_MESSAGE = "That term has already ended";
export const ALREADY_IN_THIS_AREA_MESSAGE = "This club is already in this area";
export const ALREADY_LINKED_MESSAGE =
	"This club is already linked to a GavelUp club";
export const AREA_NOT_FOUND_MESSAGE = "Area not found";
export const AREA_CLUB_NOT_FOUND_MESSAGE = "Club not found in this area";
export const DISPLAY_NAME_REQUIRED_MESSAGE = "Enter the Area Director's name";
export const DIRECTOR_NOT_VERIFIED_MESSAGE =
	"That account can't be made Area Director: its email isn't verified";
export const ARCHIVED_CLUB_MESSAGE =
	"An archived club can't be placed in an area";
export const CLUB_NUMBER_CHANGED_MESSAGE =
	"That club's number changed. Try again";
export const ASSIGN_TARGET_GONE_MESSAGE =
	"That account or area no longer exists. Reload the page";
export const ASSIGN_FAILED_MESSAGE =
	"Couldn't assign the Area Director. Try again";

/** A past program year's area takes no new Area Director: an open term there
 *  is never current, and the console offers nothing to end it. */
export function pastYearAreaMessage(programYear: number): string {
	return `${programYearLabel(programYear)} has ended, so its areas can't take a new Area Director`;
}

/** "This club is already in Area B2 for 2026–27". */
export function alreadyPlacedMessage(
	label: string,
	programYear: number,
): string {
	return `This club is already in Area ${label} for ${programYearLabel(programYear)}`;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const id = z.string().uuid();

const districtNumber = z
	.string()
	.trim()
	.min(1, "Enter a district number")
	.max(
		DISTRICT_NUMBER_MAX,
		`A district number is at most ${DISTRICT_NUMBER_MAX} characters`,
	);
const divisionLetter = z
	.string()
	.trim()
	.min(1, "Enter a division letter")
	.max(
		DIVISION_LETTER_MAX,
		`A division letter is at most ${DIVISION_LETTER_MAX} characters`,
	);
const areaNumber = z
	.string()
	.trim()
	.min(1, "Enter an area number")
	.max(
		AREA_NUMBER_MAX,
		`An area number is at most ${AREA_NUMBER_MAX} characters`,
	);

export const areaIdSchema = z.object({ areaId: id });
export const createDistrictSchema = z.object({ number: districtNumber });
export const createDivisionSchema = z.object({
	districtId: id,
	programYear: z.number().int(),
	letter: divisionLetter,
});
export const createAreaSchema = z.object({
	divisionId: id,
	number: areaNumber,
});
export const renameDivisionSchema = z.object({
	divisionId: id,
	letter: divisionLetter,
});
export const renameAreaSchema = z.object({ areaId: id, number: areaNumber });
/** `{ clubId }` places a GavelUp club; `{ name, clubNumber? }` a name-only row. */
export const addAreaClubSchema = z.object({
	areaId: id,
	clubId: id.nullish(),
	name: z
		.string()
		.trim()
		.max(
			AREA_CLUB_NAME_MAX,
			`A club name is at most ${AREA_CLUB_NAME_MAX} characters`,
		)
		.nullish(),
	clubNumber: optionalClubNumberSchema,
});
export const areaClubIdSchema = z.object({ areaClubId: id });
export const findUserForDirectorSchema = z.object({
	email: z.string().trim().max(320),
});
/** `displayName` is what the club's admins are shown, typed by the superadmin:
 *  `user.name` is "" for a magic-link account. */
export const assignAreaDirectorSchema = z.object({
	areaId: id,
	userId: z.string().min(1),
	displayName: z
		.string()
		.trim()
		.min(1, DISPLAY_NAME_REQUIRED_MESSAGE)
		.max(
			DIRECTOR_DISPLAY_NAME_MAX,
			`A name is at most ${DIRECTOR_DISPLAY_NAME_MAX} characters`,
		),
});
export const endAreaDirectorTermSchema = z.object({ termId: id });

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

interface AreaPlace {
	areaId: string;
	areaNumber: string;
	divisionId: string;
	divisionLetter: string;
	programYear: number;
	districtId: string;
	districtNumber: string;
}

async function loadAreaPlace(
	executor: Executor,
	areaId: string,
): Promise<AreaPlace> {
	const [row] = await executor
		.select({
			areaId: areas.id,
			areaNumber: areas.number,
			divisionId: divisions.id,
			divisionLetter: divisions.letter,
			programYear: divisions.programYear,
			districtId: districts.id,
			districtNumber: districts.number,
		})
		.from(areas)
		.innerJoin(divisions, eq(divisions.id, areas.divisionId))
		.innerJoin(districts, eq(districts.id, divisions.districtId))
		.where(eq(areas.id, areaId));
	if (!row) throw new Error(AREA_NOT_FOUND_MESSAGE);
	return row;
}

/**
 * Lock a GavelUp club's row for the rest of the transaction. An ARCHIVED club
 * is refused here, inside the lock, so a club archived a moment ago cannot slip
 * through a check made before it. `allowArchived` is for the one caller that
 * only needs the lock to ask where the club is already placed.
 */
async function lockClubRow(
	tx: Tx,
	clubId: string,
	opts: { allowArchived?: boolean } = {},
) {
	const [club] = await tx
		.select({
			id: clubs.id,
			name: clubs.name,
			clubNumber: clubs.clubNumber,
			archivedAt: clubs.archivedAt,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.for("update");
	if (!club) throw new Error("Club not found");
	if (club.archivedAt && !opts.allowArchived) {
		throw new Error(ARCHIVED_CLUB_MESSAGE);
	}
	return club;
}

/**
 * The GavelUp club carrying `clubNumber`, locked, or null when none does.
 *
 * The number is read BEFORE the lock, so a club renumbered in between would
 * otherwise be locked and then matched to a row it no longer belongs to: the
 * locked row's number is compared with the one asked for.
 */
async function lockClubByNumber(
	tx: Tx,
	clubNumber: string,
	opts: { allowArchived?: boolean } = {},
) {
	const [match] = await tx
		.select({ id: clubs.id })
		.from(clubs)
		.where(eq(clubs.clubNumber, clubNumber));
	if (!match) return null;
	const club = await lockClubRow(tx, match.id, opts);
	if (club.clubNumber !== clubNumber) {
		throw new Error(CLUB_NUMBER_CHANGED_MESSAGE);
	}
	return club;
}

/** The id of a row an INSERT … RETURNING should have produced. */
function inserted(row: { id: string } | undefined): { id: string } {
	if (!row) throw new Error("The insert returned no row");
	return { id: row.id };
}

/**
 * Where an OPEN term stands. Whether it is current is `area-terms-logic`'s
 * answer, passed in; only the two non-current cases are told apart here, by
 * comparing the division's year with the current one. A later year is staffed
 * ahead of July 1 (upcoming); an earlier one has been retired by the year check
 * (ended with its year).
 */
function openTermState(
	isCurrent: boolean,
	programYear: number,
	now: Date,
): Exclude<ConsoleTermState, "ended"> {
	if (isCurrent) return "current";
	return programYear > currentProgramYear(now) ? "upcoming" : "ended-with-year";
}

/**
 * Refuse unless `clubId` is in no area of `target`'s program year. Must run
 * AFTER `lockClubRow`, in the same transaction: the lock is what stops a second
 * placement of the same club from reading "not placed" while this one is
 * still inserting.
 */
async function assertNotPlacedInYear(
	tx: Tx,
	clubId: string,
	target: Pick<AreaPlace, "areaId" | "programYear">,
): Promise<void> {
	const [placed] = await tx
		.select({
			areaId: areaClubs.areaId,
			areaNumber: areas.number,
			divisionLetter: divisions.letter,
		})
		.from(areaClubs)
		.innerJoin(areas, eq(areas.id, areaClubs.areaId))
		.innerJoin(divisions, eq(divisions.id, areas.divisionId))
		.where(
			and(
				eq(areaClubs.clubId, clubId),
				eq(divisions.programYear, target.programYear),
			),
		)
		.orderBy(asc(areaClubs.createdAt), asc(areaClubs.id))
		.limit(1);
	if (!placed) return;
	if (placed.areaId === target.areaId) {
		throw new Error(ALREADY_IN_THIS_AREA_MESSAGE);
	}
	throw new Error(
		alreadyPlacedMessage(
			areaLabel(placed.divisionLetter, placed.areaNumber),
			target.programYear,
		),
	);
}

/** Natural order for text numbers: "2" before "10". */
const byNumber = (a: string, b: string) =>
	a.localeCompare(b, "en", { numeric: true });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ConsoleAreaListArea {
	id: string;
	number: string;
	label: string;
	clubCount: number;
	/** OPEN terms: 0 or 1 (the database allows one open term per area). */
	directorCount: number;
	/** Where that open term stands, or null when there is none. */
	directorState: Exclude<ConsoleTermState, "ended"> | null;
}

export interface ConsoleAreaListDivision {
	id: string;
	programYear: number;
	programYearLabel: string;
	letter: string;
	areas: ConsoleAreaListArea[];
}

export interface ConsoleAreaListDistrict {
	id: string;
	number: string;
	divisions: ConsoleAreaListDivision[];
}

export interface ConsoleAreaList {
	currentProgramYear: number;
	districts: ConsoleAreaListDistrict[];
}

/** Districts → divisions (by year, newest first) → areas, with counts. A
 *  director counts while their term is OPEN, and `directorState` says whether it
 *  is current, upcoming or retired with its year. */
export async function listConsoleAreas(
	now: Date = new Date(),
): Promise<ConsoleAreaList> {
	const rows = await db
		.select({
			districtId: districts.id,
			districtNumber: districts.number,
			divisionId: divisions.id,
			programYear: divisions.programYear,
			letter: divisions.letter,
			areaId: areas.id,
			areaNumber: areas.number,
		})
		.from(districts)
		.leftJoin(divisions, eq(divisions.districtId, districts.id))
		.leftJoin(areas, eq(areas.divisionId, divisions.id));

	const clubCounts = new Map(
		(
			await db
				.select({ areaId: areaClubs.areaId, n: count() })
				.from(areaClubs)
				.groupBy(areaClubs.areaId)
		).map((r) => [r.areaId, r.n]),
	);
	const openCounts = new Map(
		(
			await db
				.select({ areaId: areaDirectors.areaId, n: count() })
				.from(areaDirectors)
				.where(isNull(areaDirectors.endedAt))
				.groupBy(areaDirectors.areaId)
		).map((r) => [r.areaId, r.n]),
	);
	const currentAreaIds = new Set(
		(
			await db
				.select({ areaId: areaDirectors.areaId })
				.from(areaDirectors)
				.innerJoin(areas, eq(areas.id, areaDirectors.areaId))
				.innerJoin(divisions, eq(divisions.id, areas.divisionId))
				.where(isCurrentTerm(now))
		).map((r) => r.areaId),
	);

	const byDistrict = new Map<string, ConsoleAreaListDistrict>();
	const byDivision = new Map<string, ConsoleAreaListDivision>();
	for (const r of rows) {
		let district = byDistrict.get(r.districtId);
		if (!district) {
			district = { id: r.districtId, number: r.districtNumber, divisions: [] };
			byDistrict.set(r.districtId, district);
		}
		if (r.divisionId === null || r.programYear === null || r.letter === null) {
			continue;
		}
		let division = byDivision.get(r.divisionId);
		if (!division) {
			division = {
				id: r.divisionId,
				programYear: r.programYear,
				programYearLabel: programYearLabel(r.programYear),
				letter: r.letter,
				areas: [],
			};
			byDivision.set(r.divisionId, division);
			district.divisions.push(division);
		}
		if (r.areaId !== null && r.areaNumber !== null) {
			const open = openCounts.get(r.areaId) ?? 0;
			division.areas.push({
				id: r.areaId,
				number: r.areaNumber,
				label: areaLabel(r.letter, r.areaNumber),
				clubCount: clubCounts.get(r.areaId) ?? 0,
				directorCount: open,
				directorState:
					open === 0
						? null
						: openTermState(currentAreaIds.has(r.areaId), r.programYear, now),
			});
		}
	}

	const list = [...byDistrict.values()].sort((a, b) =>
		byNumber(a.number, b.number),
	);
	for (const district of list) {
		district.divisions.sort(
			(a, b) => b.programYear - a.programYear || byNumber(a.letter, b.letter),
		);
		for (const division of district.divisions) {
			division.areas.sort((a, b) => byNumber(a.number, b.number));
		}
	}
	return { currentProgramYear: currentProgramYear(now), districts: list };
}

export interface ConsoleAreaClub {
	/** `area_clubs.id`. */
	id: string;
	/** The GavelUp club, or null for a name-only row. */
	clubId: string | null;
	/** The linked club's live name; for a name-only row, the stored one. */
	name: string;
	clubNumber: string | null;
	visitCount: number;
	/** For a name-only row with a club number: the GavelUp club carrying it, when
	 *  that club is live and in no area of this program year. */
	linkOffer: { clubId: string; name: string } | null;
}

/**
 * Where a term stands. `ended` has an `ended_at`. An OPEN term is `current` in
 * this year's area, `upcoming` in next year's (staffed ahead of July 1), and
 * `ended-with-year` in a past year's: never ended, and needs no ending.
 */
export type ConsoleTermState =
	| "current"
	| "upcoming"
	| "ended"
	| "ended-with-year";

export interface ConsoleDirectorTerm {
	id: string;
	userId: string;
	/** The name typed at assignment. */
	displayName: string;
	email: string;
	startedAt: Date;
	endedAt: Date | null;
	state: ConsoleTermState;
}

export interface ConsoleAreaDetail {
	id: string;
	label: string;
	number: string;
	divisionId: string;
	divisionLetter: string;
	programYear: number;
	programYearLabel: string;
	/** The program year as of this read, so the page never asks the browser's clock. */
	currentProgramYear: number;
	districtId: string;
	districtNumber: string;
	clubs: ConsoleAreaClub[];
	/** GavelUp clubs that could be placed here: live, and in no area of this
	 *  program year yet. */
	availableClubs: { id: string; name: string; clubNumber: string | null }[];
	/** The area's OPEN term, if any; `state` says whether it is current. */
	director: ConsoleDirectorTerm | null;
	/** Terms that have an `ended_at`, latest first. */
	pastTerms: ConsoleDirectorTerm[];
}

/** One area for the console: its clubs, director and past terms. */
export async function getConsoleArea(
	areaId: string,
	now: Date = new Date(),
): Promise<ConsoleAreaDetail> {
	const place = await loadAreaPlace(db, areaId);

	const rows = await db
		.select({
			id: areaClubs.id,
			clubId: areaClubs.clubId,
			storedName: areaClubs.name,
			liveName: clubs.name,
			clubNumber: areaClubs.clubNumber,
		})
		.from(areaClubs)
		.leftJoin(clubs, eq(clubs.id, areaClubs.clubId))
		.where(eq(areaClubs.areaId, areaId));

	const rowIds = rows.map((r) => r.id);
	const visitCounts = new Map(
		rowIds.length === 0
			? []
			: (
					await db
						.select({ areaClubId: clubVisits.areaClubId, n: count() })
						.from(clubVisits)
						.where(inArray(clubVisits.areaClubId, rowIds))
						.groupBy(clubVisits.areaClubId)
				).map((r) => [r.areaClubId, r.n]),
	);

	// Clubs already in an area of THIS program year, wherever: neither offered a
	// link here (it would be refused) nor listed as available to add.
	const placedThisYear = new Set(
		(
			await db
				.selectDistinct({ clubId: areaClubs.clubId })
				.from(areaClubs)
				.innerJoin(areas, eq(areas.id, areaClubs.areaId))
				.innerJoin(divisions, eq(divisions.id, areas.divisionId))
				.where(eq(divisions.programYear, place.programYear))
		).flatMap((r) => (r.clubId ? [r.clubId] : [])),
	);

	const numbers = [
		...new Set(
			rows.flatMap((r) =>
				r.clubId === null && r.clubNumber ? [r.clubNumber] : [],
			),
		),
	];
	const offers = new Map(
		numbers.length === 0
			? []
			: (
					await db
						.select({
							id: clubs.id,
							name: clubs.name,
							clubNumber: clubs.clubNumber,
						})
						.from(clubs)
						.where(
							and(inArray(clubs.clubNumber, numbers), isNull(clubs.archivedAt)),
						)
				).flatMap((c) =>
					c.clubNumber && !placedThisYear.has(c.id)
						? [[c.clubNumber, c] as const]
						: [],
				),
	);

	const areaClubList: ConsoleAreaClub[] = rows
		.map((r) => {
			const offer =
				r.clubId === null && r.clubNumber
					? offers.get(r.clubNumber)
					: undefined;
			return {
				id: r.id,
				clubId: r.clubId,
				name: r.liveName ?? r.storedName,
				clubNumber: r.clubNumber,
				visitCount: visitCounts.get(r.id) ?? 0,
				linkOffer: offer ? { clubId: offer.id, name: offer.name } : null,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name, "en"));

	const availableClubs = (
		await db
			.select({ id: clubs.id, name: clubs.name, clubNumber: clubs.clubNumber })
			.from(clubs)
			.where(isNull(clubs.archivedAt))
			.orderBy(asc(clubs.name))
	).filter((c) => !placedThisYear.has(c.id));

	// Whether the open term is CURRENT is `area-terms-logic`'s answer. What this
	// file adds is telling the two non-current cases apart (`openTermState`).
	const openState = openTermState(
		(await loadCurrentDirector(areaId, now)) !== null,
		place.programYear,
		now,
	);
	const terms: ConsoleDirectorTerm[] = (
		await db
			.select({
				id: areaDirectors.id,
				userId: areaDirectors.userId,
				displayName: areaDirectors.displayName,
				email: user.email,
				startedAt: areaDirectors.startedAt,
				endedAt: areaDirectors.endedAt,
			})
			.from(areaDirectors)
			.innerJoin(user, eq(user.id, areaDirectors.userId))
			.where(eq(areaDirectors.areaId, areaId))
			.orderBy(desc(areaDirectors.startedAt), desc(areaDirectors.id))
	).map((t) => ({ ...t, state: t.endedAt === null ? openState : "ended" }));

	return {
		id: place.areaId,
		label: areaLabel(place.divisionLetter, place.areaNumber),
		number: place.areaNumber,
		divisionId: place.divisionId,
		divisionLetter: place.divisionLetter,
		programYear: place.programYear,
		programYearLabel: programYearLabel(place.programYear),
		currentProgramYear: currentProgramYear(now),
		districtId: place.districtId,
		districtNumber: place.districtNumber,
		clubs: areaClubList,
		availableClubs,
		director: terms.find((t) => t.endedAt === null) ?? null,
		pastTerms: terms.filter((t) => t.endedAt !== null),
	};
}

// ---------------------------------------------------------------------------
// Creating and renaming the hierarchy
// ---------------------------------------------------------------------------

export async function createDistrict(
	input: z.infer<typeof createDistrictSchema>,
): Promise<{ id: string }> {
	try {
		const [row] = await db
			.insert(districts)
			.values({ number: input.number })
			.returning({ id: districts.id });
		return inserted(row);
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw new Error(`District ${input.number} already exists`);
		}
		throw err;
	}
}

/** A division's year must be the current program year or the next one. */
export async function createDivision(
	input: z.infer<typeof createDivisionSchema>,
	now: Date = new Date(),
): Promise<{ id: string }> {
	const current = currentProgramYear(now);
	if (input.programYear !== current && input.programYear !== current + 1) {
		throw new Error(
			`A division's program year must be ${programYearLabel(current)} or ${programYearLabel(current + 1)}`,
		);
	}
	const [district] = await db
		.select({ number: districts.number })
		.from(districts)
		.where(eq(districts.id, input.districtId));
	if (!district) throw new Error("District not found");
	try {
		const [row] = await db
			.insert(divisions)
			.values({
				districtId: input.districtId,
				programYear: input.programYear,
				letter: input.letter,
			})
			.returning({ id: divisions.id });
		return inserted(row);
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw new Error(
				`Division ${input.letter} already exists in District ${district.number} for ${programYearLabel(input.programYear)}`,
			);
		}
		throw err;
	}
}

export async function createArea(
	input: z.infer<typeof createAreaSchema>,
): Promise<{ id: string }> {
	const [division] = await db
		.select({ letter: divisions.letter, programYear: divisions.programYear })
		.from(divisions)
		.where(eq(divisions.id, input.divisionId));
	if (!division) throw new Error("Division not found");
	try {
		const [row] = await db
			.insert(areas)
			.values({ divisionId: input.divisionId, number: input.number })
			.returning({ id: areas.id });
		return inserted(row);
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw new Error(
				`Area ${areaLabel(division.letter, input.number)} already exists for ${programYearLabel(division.programYear)}`,
			);
		}
		throw err;
	}
}

/** Fix a division's letter. Its areas and clubs follow, being children of it. */
export async function renameDivision(
	input: z.infer<typeof renameDivisionSchema>,
): Promise<void> {
	const [division] = await db
		.select({
			programYear: divisions.programYear,
			districtNumber: districts.number,
		})
		.from(divisions)
		.innerJoin(districts, eq(districts.id, divisions.districtId))
		.where(eq(divisions.id, input.divisionId));
	if (!division) throw new Error("Division not found");
	try {
		await db
			.update(divisions)
			.set({ letter: input.letter, updatedAt: sql`now()` })
			.where(eq(divisions.id, input.divisionId));
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw new Error(
				`Division ${input.letter} already exists in District ${division.districtNumber} for ${programYearLabel(division.programYear)}`,
			);
		}
		throw err;
	}
}

/** Fix an area's number. */
export async function renameArea(
	input: z.infer<typeof renameAreaSchema>,
): Promise<void> {
	const place = await loadAreaPlace(db, input.areaId);
	try {
		await db
			.update(areas)
			.set({ number: input.number, updatedAt: sql`now()` })
			.where(eq(areas.id, input.areaId));
	} catch (err) {
		if (isUniqueViolation(err)) {
			throw new Error(
				`Area ${areaLabel(place.divisionLetter, input.number)} already exists for ${programYearLabel(place.programYear)}`,
			);
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Clubs in an area
// ---------------------------------------------------------------------------

/**
 * Place a club in an area: a GavelUp club (`clubId`, whose name and club number
 * are copied) or a name-only row (`name`, optional `clubNumber`).
 *
 * An ARCHIVED club is refused (the console does not offer one; the server holds
 * the line). A name-only row whose `clubNumber` is a GavelUp club's is that
 * club under another spelling, so it takes the same lock and the same
 * one-area-per-year check as placing the club itself; it is still inserted
 * name-only, to be linked afterwards.
 */
export async function addAreaClub(
	input: z.input<typeof addAreaClubSchema>,
): Promise<{ id: string }> {
	const target = await loadAreaPlace(db, input.areaId);

	if (input.clubId) {
		const clubId = input.clubId;
		return db.transaction(async (tx) => {
			const club = await lockClubRow(tx, clubId);
			await assertNotPlacedInYear(tx, club.id, target);
			const [row] = await tx
				.insert(areaClubs)
				.values({
					areaId: target.areaId,
					clubId: club.id,
					name: club.name,
					clubNumber: club.clubNumber,
				})
				.returning({ id: areaClubs.id });
			return inserted(row);
		});
	}

	const name = input.name?.trim();
	if (!name) throw new Error("Enter the club's name");
	const clubNumber = input.clubNumber || null;
	return db.transaction(async (tx) => {
		if (clubNumber) {
			const club = await lockClubByNumber(tx, clubNumber, {
				allowArchived: true,
			});
			if (club) await assertNotPlacedInYear(tx, club.id, target);
		}
		const [row] = await tx
			.insert(areaClubs)
			.values({ areaId: target.areaId, name, clubNumber })
			.returning({ id: areaClubs.id });
		return inserted(row);
	});
}

/** Link a name-only row to the GavelUp club carrying the same club number. */
export async function linkAreaClub(
	input: z.infer<typeof areaClubIdSchema>,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ clubId: areaClubs.clubId, clubNumber: areaClubs.clubNumber })
			.from(areaClubs)
			.where(eq(areaClubs.id, input.areaClubId));
		if (!row) throw new Error(AREA_CLUB_NOT_FOUND_MESSAGE);
		if (row.clubId) throw new Error(ALREADY_LINKED_MESSAGE);
		if (!row.clubNumber) {
			throw new Error("This club has no club number to match");
		}

		// Lock order: the club, then the area-club row. `deleteClubPermanently`
		// locks the club and then reaches this row through ON DELETE SET NULL, so
		// taking them the other way round could deadlock against it.
		const club = await lockClubByNumber(tx, row.clubNumber);
		if (!club) {
			throw new Error(`No GavelUp club has club number ${row.clubNumber}`);
		}
		const [locked] = await tx
			.select({ clubId: areaClubs.clubId, areaId: areaClubs.areaId })
			.from(areaClubs)
			.where(eq(areaClubs.id, input.areaClubId))
			.for("update");
		if (!locked) throw new Error(AREA_CLUB_NOT_FOUND_MESSAGE);
		if (locked.clubId) throw new Error(ALREADY_LINKED_MESSAGE);

		const target = await loadAreaPlace(tx, locked.areaId);
		await assertNotPlacedInYear(tx, club.id, target);
		await tx
			.update(areaClubs)
			.set({ clubId: club.id, name: club.name, updatedAt: sql`now()` })
			.where(eq(areaClubs.id, input.areaClubId));
	});
}

/**
 * Remove a club from an area. Refused when any visit is recorded against it:
 * the console says so here, and `club_visits.area_club_id` is RESTRICT, so the
 * database refuses it too. The row is locked first, so a visit cannot be
 * inserted between the check and the delete.
 */
export async function removeAreaClub(
	input: z.infer<typeof areaClubIdSchema>,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ id: areaClubs.id })
			.from(areaClubs)
			.where(eq(areaClubs.id, input.areaClubId))
			.for("update");
		if (!row) throw new Error(AREA_CLUB_NOT_FOUND_MESSAGE);
		const [visit] = await tx
			.select({ id: clubVisits.id })
			.from(clubVisits)
			.where(eq(clubVisits.areaClubId, input.areaClubId))
			.limit(1);
		if (visit) throw new Error(CLUB_HAS_VISITS_MESSAGE);
		await tx.delete(areaClubs).where(eq(areaClubs.id, input.areaClubId));
	});
}

// ---------------------------------------------------------------------------
// The Area Director
// ---------------------------------------------------------------------------

/**
 * The account an email names, for the superadmin to make Area Director. No
 * `name`: it is "" for a magic-link account, so the superadmin types the name
 * the club's admins will see (`assignAreaDirector`'s `displayName`). An
 * EXACT, case-insensitive match on `user.email`, and only a VERIFIED one: an
 * address nobody has proven they hold must not be a way to hand someone the
 * office, and a near-miss must find nothing rather than the closest account.
 * Returns null when nothing matches, and when two accounts differ only by
 * case (ambiguous, so neither).
 */
export async function findUserForDirector(
	input: z.infer<typeof findUserForDirectorSchema>,
): Promise<{ id: string; email: string } | null> {
	const email = normalizeEmail(input.email);
	if (!email) return null;
	const rows = await db
		.select({ id: user.id, email: user.email })
		.from(user)
		.where(
			and(eq(normalizedEmail(user.email), email), eq(user.emailVerified, true)),
		)
		.limit(2);
	return rows.length === 1 ? (rows[0] ?? null) : null;
}

/**
 * What a failed term insert says to the person, never the driver's text (which
 * quotes the whole parameterised query). A unique violation is the one-open-term
 * rule; an FK violation is an account or area deleted between the checks and
 * the insert; anything else is logged here and answered plainly.
 */
export function assignDirectorFailure(err: unknown): Error {
	if (isUniqueViolation(err)) return new Error(CURRENT_TERM_EXISTS_MESSAGE);
	if (isSqlState(err, "23503")) return new Error(ASSIGN_TARGET_GONE_MESSAGE);
	console.error("[areas] assignAreaDirector failed", err);
	return new Error(ASSIGN_FAILED_MESSAGE);
}

/**
 * Open a term for `userId` on an area. One OPEN term per area is the
 * database's rule (`area_directors_open_unique`), so a concurrent second
 * assignment fails there and comes back as the refusal, not a 500.
 *
 * A PAST program year's area is refused: an open term there is never current,
 * and the console offers nothing to end it. A year already staffed ahead of
 * July 1 (the next one) is allowed.
 */
export async function assignAreaDirector(
	input: z.infer<typeof assignAreaDirectorSchema>,
	assignedBy: string,
	now: Date = new Date(),
): Promise<{ id: string }> {
	// The schema trims and refuses blank, but this is also called directly, and
	// the name is what #1118 shows the club's admins.
	const displayName = input.displayName.trim();
	if (!displayName) throw new Error(DISPLAY_NAME_REQUIRED_MESSAGE);
	const place = await loadAreaPlace(db, input.areaId);
	if (place.programYear < currentProgramYear(now)) {
		throw new Error(pastYearAreaMessage(place.programYear));
	}
	const [candidate] = await db
		.select({ emailVerified: user.emailVerified })
		.from(user)
		.where(eq(user.id, input.userId));
	if (!candidate?.emailVerified) {
		throw new Error(DIRECTOR_NOT_VERIFIED_MESSAGE);
	}
	try {
		const [row] = await db
			.insert(areaDirectors)
			.values({
				areaId: input.areaId,
				userId: input.userId,
				displayName,
				assignedBy,
			})
			.returning({ id: areaDirectors.id });
		return inserted(row);
	} catch (err) {
		throw assignDirectorFailure(err);
	}
}

/** Close a term. `ended_at` is the database's clock, as `started_at` is. */
export async function endAreaDirectorTerm(
	input: z.infer<typeof endAreaDirectorTermSchema>,
	endedBy: string,
): Promise<void> {
	const ended = await db
		.update(areaDirectors)
		.set({ endedAt: sql`now()`, endedBy, updatedAt: sql`now()` })
		.where(
			and(eq(areaDirectors.id, input.termId), isNull(areaDirectors.endedAt)),
		)
		.returning({ id: areaDirectors.id });
	if (ended.length === 0) throw new Error(NO_CURRENT_TERM_MESSAGE);
}

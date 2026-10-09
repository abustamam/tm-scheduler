// The Area Director's club visits (#1120, part of #1115): the shared shapes and
// the pure rules, in `src/lib` so the server fns, the cell that edits them and
// the print page all read ONE copy. No `#/db` import: client code reads this.
//
// A visit is a date and a round. There are two rounds a program year (the
// Toastmasters visit rounds), one row each per area club. Nothing here names a
// person: who recorded a visit is kept in the table and never sent to a page.

import type { ClubHealth } from "#/lib/area-health";

/** One club's page of the print summary (#1120). */
export interface AreaClubSummary {
	areaId: string;
	label: string;
	programYear: number;
	/** The instant the numbers were read, ISO. */
	asOf: string;
	club: ClubHealth;
	visits: ClubVisits;
}

/** The two visit rounds. */
export const VISIT_ROUNDS = [1, 2] as const;
export type VisitRound = (typeof VISIT_ROUNDS)[number];

/** One club's visits: a round is absent until it is recorded. ISO `YYYY-MM-DD`. */
export type ClubVisits = Partial<Record<VisitRound, string>>;

/** `{ areaClubId → visits }`, for every club in an area that has a visit. */
export type AreaVisits = Record<string, ClubVisits>;

export const VISIT_IN_FUTURE_MESSAGE = "A visit can't be dated in the future";
export const VISIT_DATE_INVALID_MESSAGE = "Enter the visit date";
export const VISIT_ROUND_INVALID_MESSAGE = "A visit is round 1 or round 2";

/** `YYYY-MM-DD` that is a real calendar day (not `2026-02-31`). */
export function isIsoDate(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const probe = new Date(Date.UTC(y, mo - 1, d));
	return (
		probe.getUTCFullYear() === y &&
		probe.getUTCMonth() === mo - 1 &&
		probe.getUTCDate() === d
	);
}

/**
 * The program year's window as ISO dates: `[start, end)`. Strings, because a
 * `Date` window (`programYearWindow`) is built in the SERVER'S local time and
 * would move the July 1 boundary with the machine's zone. An ISO date compares
 * correctly as a string, in any zone.
 */
export function programYearIsoWindow(programYear: number): {
	start: string;
	end: string;
} {
	return { start: `${programYear}-07-01`, end: `${programYear + 1}-07-01` };
}

/** Why the program year refuses a date, in the words a toast shows. */
export function outsideProgramYearMessage(programYear: number): string {
	return `That date is outside the ${programYear}–${String(
		(programYear + 1) % 100,
	).padStart(2, "0")} program year (July 1 to June 30)`;
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/**
 * "Oct 12" for the visit date `2026-10-12`. Read off the string, never through
 * a `Date`: a date-only value has no zone, and `new Date("2026-10-12")` is
 * midnight UTC, which a browser west of Greenwich prints as the 11th (#1017).
 */
export function formatVisitDate(iso: string): string {
	const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return iso;
	return `${MONTHS[Number(m[1]) - 1] ?? "?"} ${Number(m[2])}`;
}

/** Where a club's one-page visit summary prints. */
export function areaClubPrintPath(areaId: string, areaClubId: string): string {
	return `/area/${areaId}/club/${areaClubId}/print`;
}

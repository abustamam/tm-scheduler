// A club's charter status (#944), stated once. Pure: no `#/db`, so the client
// routes and the server write paths import the SAME vocabulary and the same
// invariant.
//
// `chartering` is a club that is forming and uses GavelUp before charter; it
// may or may not hold a club number yet (a forming club is sometimes assigned
// one before it charters). `chartered` is every other club.
import { z } from "zod";

/** Keep in lockstep with `clubCharterStatusEnum` in `src/db/schema.ts`. */
export const CHARTER_STATUSES = ["chartering", "chartered"] as const;
export type CharterStatus = (typeof CHARTER_STATUSES)[number];

export const CHARTER_STATUS_LABEL: Record<CharterStatus, string> = {
	chartering: "Chartering",
	chartered: "Chartered",
};

export const CLUB_NUMBER_REQUIRED_MESSAGE =
	"A chartered club needs a club number.";
export const CHARTER_DATE_INVALID_MESSAGE =
	"Enter the charter date as a real calendar date.";
export const CHARTER_DATE_FUTURE_MESSAGE =
	"The charter date can't be in the future.";

/**
 * The invariant between status and number, or null when it holds. A chartered
 * club must have a club number; a chartering club may have none. Every write
 * that sets either column calls this — the database cannot hold it as a CHECK,
 * because the migration that added the status backfilled every existing club
 * as chartered whatever its number (see the column comment in `schema.ts`).
 */
export function charterInvariantError(input: {
	charterStatus: CharterStatus;
	clubNumber: string | null | undefined;
}): string | null {
	if (input.charterStatus === "chartered" && !input.clubNumber?.trim()) {
		return CLUB_NUMBER_REQUIRED_MESSAGE;
	}
	return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a `YYYY-MM-DD` string naming a real calendar day (no Feb 30). */
export function isCalendarDate(value: string): boolean {
	if (!ISO_DATE.test(value)) return false;
	const d = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * The latest charter date accepted, as `YYYY-MM-DD`: tomorrow in UTC. One day
 * of slack rather than "today in UTC" because the admin types a date in their
 * own zone, and a club east of UTC is already on tomorrow's date for part of
 * every day. Anything later is a typo, not a charter.
 */
export function latestCharterDate(now: Date = new Date()): string {
	const d = new Date(now.getTime() + 24 * 60 * 60 * 1000);
	return d.toISOString().slice(0, 10);
}

/** A charter date: a real `YYYY-MM-DD` calendar day, not in the future. */
export const charterDateSchema = z
	.string()
	.trim()
	.refine(isCalendarDate, { message: CHARTER_DATE_INVALID_MESSAGE })
	.refine((v) => v <= latestCharterDate(), {
		message: CHARTER_DATE_FUTURE_MESSAGE,
	});

/** A club number as a form sends it: trimmed, "" read as absent (null). */
export const optionalClubNumberSchema = z
	.string()
	.trim()
	.max(32, "That club number is too long.")
	.nullish()
	.transform((v) => (v ? v : null));

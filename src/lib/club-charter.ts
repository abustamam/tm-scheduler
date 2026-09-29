// A club's charter status (#944), stated once. Pure: no `#/db`, so the client
// routes and the server write paths import the SAME vocabulary and the same
// invariant.
//
// `chartering` is a club that is forming and uses GavelUp before charter; it
// may or may not hold a club number yet (a forming club is sometimes assigned
// one before it charters). `chartered` is every other club.
import { z } from "zod";

/** Restated in `clubCharterStatusEnum` (`src/db/schema.ts`), which may not
 *  import this module; `club-charter.test.ts` holds the two equal. */
export const CHARTER_STATUSES = ["chartering", "chartered"] as const;
export type CharterStatus = (typeof CHARTER_STATUSES)[number];

export const CHARTER_STATUS_LABEL: Record<CharterStatus, string> = {
	chartering: "Chartering",
	chartered: "Chartered",
};

/**
 * What a Toastmasters club number looks like: 1 to 8 digits. The ONE statement
 * of it — the request-access form's bound (`ACCESS_REQUEST_BOUNDS`) reads this,
 * and so does every write of `clubs.club_number`. Written UNANCHORED for an
 * HTML `pattern` attribute (which anchors implicitly); `CLUB_NUMBER_RE` is the
 * anchored form.
 *
 * It matters beyond tidiness because a club number is a URL identifier:
 * `resolveClubByIdentifier` tries slug, then club NUMBER, then UUID. Marking a
 * club chartered is the first writer of the column that is not a superadmin
 * (any club admin or open officer), and free text there could claim another
 * club's UUID ahead of the UUID match itself.
 */
export const CLUB_NUMBER_PATTERN = "\\d{1,8}";
export const CLUB_NUMBER_MAX = 8;
export const CLUB_NUMBER_RE = new RegExp(`^(?:${CLUB_NUMBER_PATTERN})$`);
export const CLUB_NUMBER_FORMAT_MESSAGE = "A club number is digits only.";

export const CLUB_NUMBER_REQUIRED_MESSAGE =
	"A chartered club needs a club number.";
/**
 * A chartered club provisioned through the app must state its charter date
 * (#944: null is allowed only for backfilled clubs). The reload hint is for a
 * console tab loaded before the charter fields existed: it sends no status,
 * which defaults to chartered, and no date — so it lands here.
 */
export const CHARTER_DATE_REQUIRED_MESSAGE =
	"A chartered club needs its charter date. If the form has no charter date field, reload the page.";
/** The earliest charter date accepted: the day Toastmasters was founded. */
export const EARLIEST_CHARTER_DATE = "1924-10-22";
export const CHARTER_DATE_TOO_EARLY_MESSAGE =
	"The charter date can't be before October 22, 1924.";
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

/** A charter date: a real `YYYY-MM-DD` calendar day, no earlier than the day
 *  Toastmasters was founded and not in the future. */
export const charterDateSchema = z
	.string()
	.trim()
	.refine(isCalendarDate, { message: CHARTER_DATE_INVALID_MESSAGE })
	.refine((v) => v >= EARLIEST_CHARTER_DATE, {
		message: CHARTER_DATE_TOO_EARLY_MESSAGE,
	})
	.refine((v) => v <= latestCharterDate(), {
		message: CHARTER_DATE_FUTURE_MESSAGE,
	});

/** A club number as a form sends it: trimmed, "" read as absent (null), and
 *  otherwise digits only (`CLUB_NUMBER_PATTERN`). */
export const optionalClubNumberSchema = z
	.string()
	.trim()
	.nullish()
	.transform((v) => (v ? v : null))
	.pipe(
		z.string().regex(CLUB_NUMBER_RE, CLUB_NUMBER_FORMAT_MESSAGE).nullable(),
	);

/** The refusal for a club number another club already holds. */
export function duplicateNumberMessage(clubNumber: string): string {
	return `A club with number ${clubNumber} already exists.`;
}

/**
 * The `superRefine` body every schema that sets a charter status shares: run
 * `charterInvariantError` and report it against `clubNumber`.
 */
export function refineCharterInvariant(
	v: { charterStatus: CharterStatus; clubNumber: string | null | undefined },
	ctx: z.RefinementCtx,
): void {
	const invariant = charterInvariantError(v);
	if (invariant) {
		ctx.addIssue({ code: "custom", path: ["clubNumber"], message: invariant });
	}
}

/**
 * The request-access form's answers to "Has your club chartered?", in the
 * order offered. "" is "not said", the default: the question is optional like
 * the club number, and the server stores nothing for it.
 */
export const CHARTER_OPTIONS: ReadonlyArray<{
	value: CharterStatus | "";
	label: string;
}> = [
	{ value: "", label: "Choose one" },
	{ value: "chartered", label: "Yes, it's chartered" },
	{ value: "chartering", label: "Not yet, it's still forming" },
];

/**
 * The club timezone allowlist and its validator (#547).
 *
 * In `lib/` rather than beside the writer for the reason CLAUDE.md's coverage
 * notes give: a constant defined in a module that imports `#/db` is unassertable,
 * because a unit test importing it throws `DATABASE_URL is not set`. The zone
 * list and the predicate over it are exactly the things worth asserting.
 */

/** Mirrors the `clubs.timezone` column default in `schema.ts`. */
export const DEFAULT_CLUB_TIMEZONE = "America/Chicago";

/**
 * `UTC` is not in `Intl.supportedValuesOf("timeZone")` on the ICU builds this
 * runs against — neither is any `Etc/*` zone — but it is the string the codebase
 * already falls back to wherever a club row is missing
 * (`meeting-resolve-logic.ts`, `past-meetings-logic.ts`, `meetings.ts`), every
 * `Intl` API accepts it, and it is the honest answer for an online-only club. So
 * it is added explicitly rather than left as a gap an admin cannot express.
 */
const EXTRA_TIMEZONES = ["UTC"] as const;

/**
 * Every zone a club may be set to, sorted: this runtime's canonical IANA list
 * plus {@link EXTRA_TIMEZONES}.
 *
 * This is the SERVER's list, and the picker renders it (shipped down by
 * `loadClubTimezoneSettings`) rather than calling `Intl` in the browser. Two ICU
 * builds disagree about which spelling of an alias pair is canonical — this Node
 * lists `Asia/Calcutta` where a newer browser lists `Asia/Kolkata` — so a picker
 * built from the BROWSER's list would offer options the server rejects, and,
 * worse, would fail to display a saved value spelled the server's way: the
 * `<option>` would not exist, so the select would silently show its first entry
 * instead of the club's actual zone. One list, produced once, on the side that
 * validates, removes both failures by construction.
 */
export const CLUB_TIMEZONES: readonly string[] = [
	...new Set([...Intl.supportedValuesOf("timeZone"), ...EXTRA_TIMEZONES]),
].sort();

const CLUB_TIMEZONE_SET: ReadonlySet<string> = new Set(CLUB_TIMEZONES);

/**
 * The zod rejection message for an unsupported zone. Reaches a user only as the
 * server's error text in the settings toast — the picker cannot offer an invalid
 * option, so there is no client-side check that renders it.
 */
export const INVALID_TIMEZONE_MESSAGE = "Choose a valid time zone.";

/**
 * Exact membership in {@link CLUB_TIMEZONES} — deliberately stricter than "a
 * string `Intl.DateTimeFormat` will accept".
 *
 * `Intl` also accepts alias spellings, `"utc"` in any case, and (per newer
 * spec revisions) bare offsets like `"+05:30"`. Any of those would format
 * without throwing and so would look fine, while storing a non-canonical value
 * that the picker cannot display and that a later ICU update may stop
 * resolving. The column feeds `zonedWallTimeToUtc` on every meeting write and
 * `utcToZonedWallTime` on every URL date key, both of which throw a `RangeError`
 * on a zone `Intl` cannot resolve, so a bad value here is not a cosmetic
 * problem — it takes out meeting creation and every meeting link at once.
 */
export function isSupportedClubTimezone(timezone: string): boolean {
	return CLUB_TIMEZONE_SET.has(timezone);
}

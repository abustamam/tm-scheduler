/**
 * The bounds and refusal text the area console shares between the server fns
 * that enforce them and the pages that state them (#1116). Client-safe: no
 * `#/db`, no server import.
 *
 * One definition each, because a page that writes `maxLength={4}` beside a
 * server that checks `max(4)` is two numbers that drift, and the first sign is
 * a form that accepts what the server then refuses.
 */

/** A district's TI number as text: "39", "F". */
export const DISTRICT_NUMBER_MAX = 8;
/** A division letter: "C". */
export const DIVISION_LETTER_MAX = 4;
/** An area number within its division: "3". */
export const AREA_NUMBER_MAX = 4;
/** A club's name as typed for a club that is not on GavelUp. */
export const AREA_CLUB_NAME_MAX = 120;
/** The name the club's admins are shown for an Area Director. */
export const DIRECTOR_DISPLAY_NAME_MAX = 120;

/**
 * Refusing to remove an area club that has a visit. The server throws it, and
 * the console puts the same sentence on the disabled Remove button.
 */
export const CLUB_HAS_VISITS_MESSAGE = "This club has recorded visits";

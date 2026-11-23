/**
 * The "is this name close to someone we already know" rule, shared by
 * `record_attendance` (a `newGuest` line) and the guest-book planner (#1658),
 * so the two cannot disagree about whether one name is a possible duplicate.
 *
 * Pure: no database, no session. It is the `find_people` matcher plus a shared
 * whole word, as `add_members` does.
 */

import { isBlankQuery, matchTier } from "#/lib/person-search";
import { toStoredPhone } from "#/lib/phone";

export const fold = (s: string | null | undefined) =>
	(s ?? "").trim().toLowerCase();

const wordsOf = (s: string | null | undefined) =>
	fold(s)
		.split(/\s+/)
		.filter((w) => w.length >= 2);

/** The name is close to a known person, in either direction or by a shared whole word. */
export function closeTo(
	name: string,
	p: { name: string; preferredName?: string | null },
): boolean {
	if (matchTier(name, p) !== null || matchTier(p.name, { name }) !== null) {
		return true;
	}
	const mine = new Set(wordsOf(name));
	return [...wordsOf(p.name), ...wordsOf(p.preferredName)].some((w) =>
		mine.has(w),
	);
}

/** The shortest folded name the guest-book planner will near-name match on. */
export const MIN_NEAR_NAME_LENGTH = 3;

/**
 * Whether a typed name is distinctive enough to ask "is this someone we know".
 * A name that folds to nothing (punctuation only) matches EVERYONE in
 * `matchTier`, and one or two letters are a substring of most of a club, so
 * neither may enumerate the roster. Contact equality is not subject to this.
 * Used by the guest-book planner; `record_attendance` keeps `closeTo` as is.
 */
export function nameIsMatchable(name: string): boolean {
	return !isBlankQuery(name) && fold(name).length >= MIN_NEAR_NAME_LENGTH;
}

/** `closeTo`, but never for a name too short or empty to mean anything. */
export function nearName(
	name: string,
	p: { name: string; preferredName?: string | null },
): boolean {
	return nameIsMatchable(name) && closeTo(name, p);
}

/**
 * A member who already holds this email or phone is the existing person,
 * whatever the name says. `input.phone` is the E.164 STORED form; the member's
 * phone is normalised here with the club's default country code.
 */
export function sharesContact(
	member: { email: string | null; phone: string | null },
	input: { email: string | null; phone: string | null },
	defaultCountryCode?: string | null,
): boolean {
	return (
		(input.email !== null &&
			fold(member.email) === input.email.toLowerCase()) ||
		(input.phone !== null &&
			member.phone !== null &&
			toStoredPhone(member.phone, defaultCountryCode) === input.phone)
	);
}

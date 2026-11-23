/**
 * The "is this name close to someone we already know" rule, shared by
 * `record_attendance` (a `newGuest` line) and the guest-book planner (#1658),
 * so the two cannot disagree about whether one name is a possible duplicate.
 *
 * Pure: no database, no session. It is the `find_people` matcher plus a shared
 * whole word, as `add_members` does.
 */
import { matchTier } from "#/lib/person-search";

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

/**
 * A member who already holds this email or phone is the existing person,
 * whatever the name says. `phone` is the E.164 STORED form; `memberPhone` must
 * already be stored-form too (the caller normalises it).
 */
export function sharesContact(
	member: { email: string | null; phone: string | null },
	input: { email: string | null; phone: string | null },
	memberPhone: string | null,
): boolean {
	return (
		(input.email !== null &&
			fold(member.email) === input.email.toLowerCase()) ||
		(input.phone !== null &&
			member.phone !== null &&
			memberPhone === input.phone)
	);
}

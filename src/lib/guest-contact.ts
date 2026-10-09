/**
 * Why a club's officer may not change a guest's email or phone (#1125, ADR-0031).
 *
 * A guest's contact lives on their Person, and the Person owns it: clubs are
 * custodians until the person speaks for themselves. An officer may correct the
 * contact of a guest-only Person nobody has signed in as and who never was a
 * member (the fix shows in every club that holds a guest row on them, because it
 * is one person with one address), and of nobody else. Everyone else is refused
 * with one of the sentences below, the FIRST that applies, in this order.
 *
 * In `lib/` and not beside `guestContactWritable` because that module imports
 * `#/db` at load: a sentence nothing can import is a sentence nothing can
 * assert, and the Edit guest dialog needs the same sentences the server throws.
 */
export type GuestContactRefusal =
	/** Somebody has signed in as this Person; the contact is theirs. */
	| "signed_in"
	/** The Person holds a membership in THIS club: edit them on the roster. */
	| "member_here"
	/** The Person holds a membership in another club, which manages it. */
	| "member_elsewhere"
	/** The Person WAS a member (a removal or a roster-identity column shows it): it
	 *  holds none now, but its contact is the member's and stays as it was. */
	| "former_member";

/** The order the refusals are tried in. Also the order of the SQL `CASE`. */
export const GUEST_CONTACT_REFUSAL_ORDER = [
	"signed_in",
	"member_here",
	"member_elsewhere",
	"former_member",
] as const satisfies readonly GuestContactRefusal[];

export const GUEST_CONTACT_REFUSAL_MESSAGES: Record<
	GuestContactRefusal,
	string
> = {
	signed_in: "This person has signed in. They change it themselves.",
	member_here: "They're a member here. Edit them on their member page.",
	member_elsewhere:
		"They're a member of another club, which manages their contact.",
	former_member: "They were a member before, so their contact stays as it was.",
};

/** A value the server sent that is not one of the three reasons, narrowed. */
export function isGuestContactRefusal(
	value: unknown,
): value is GuestContactRefusal {
	return (
		typeof value === "string" &&
		(GUEST_CONTACT_REFUSAL_ORDER as readonly string[]).includes(value)
	);
}

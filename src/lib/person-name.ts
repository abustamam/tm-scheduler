// Reading a stored full name (#486). Pure and client-safe — no `#/db` — so the
// client meeting route can import it the way it imports `nudge.ts`.
//
// Every intake path gives us ONE name string: the Toastmasters membership
// export has a single `Name` column, and the paste-roster parser is
// `name, email, phone, office`. So there is no first/last to read; there is
// only a string to interpret, and interpretation is often wrong — "Abdul-Rasheed
// Bustamam" goes by Rasheed, a Robert may go by Bob, and plenty of names put the
// family name first. `preferredName` is where a human records the answer;
// everything here is the fallback for when nobody has.

export interface NamedPerson {
	name: string;
	preferredName?: string | null;
}

/** The first whitespace-separated token, or `""`. */
function firstToken(s: string): string {
	return s.trim().split(/\s+/).filter(Boolean)[0] ?? "";
}

/**
 * The name to greet someone by, read off a single stored full name.
 *
 * Handles both shapes the Toastmasters export actually emits. Most rows are
 * "First Last", but the CSV also carries "Last, First" (see
 * `members-csv.test.ts`) — for those, the given name is what FOLLOWS the comma.
 * Splitting on whitespace alone returns `"Khan,"` there, which produces
 * "Hi Khan,, just confirming…": a doubled comma, addressing the person by their
 * family name, in a message a human is about to send to another human.
 *
 * The trailing-punctuation strip is the belt to that suspenders: a name ending
 * in a stray comma with nothing after it still greets cleanly.
 */
export function firstNameOf(name: string): string {
	const trimmed = name.trim();
	const comma = trimmed.indexOf(",");
	if (comma !== -1) {
		const given = firstToken(trimmed.slice(comma + 1));
		if (given) return given.replace(/[,;]+$/, "");
	}
	return firstToken(trimmed).replace(/[,;]+$/, "");
}

/**
 * What to call this person in a message. The recorded `preferredName` wins;
 * otherwise the first token of their full name.
 *
 * An all-whitespace `preferredName` counts as unset: a cleared text input
 * submits `""`, not `null`, and greeting someone by an empty string is worse
 * than guessing.
 */
export function greetingName(p: NamedPerson): string {
	return p.preferredName?.trim() || firstNameOf(p.name);
}

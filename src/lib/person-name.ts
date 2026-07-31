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

/** Whitespace-separated parts, with surrounding and repeated whitespace gone. */
function parts(name: string): string[] {
	return name.trim().split(/\s+/).filter(Boolean);
}

/** The first token of a full name. `""` for a blank name. */
export function firstNameOf(name: string): string {
	return parts(name)[0] ?? "";
}

/**
 * The last token of a full name. `""` for a mononym or a blank name — callers
 * get "no family name recorded" rather than a duplicate of the first name.
 */
export function lastNameOf(name: string): string {
	const p = parts(name);
	return p.length > 1 ? (p[p.length - 1] ?? "") : "";
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

/**
 * Sort key for roster-style ordering: family name first, then given name, so
 * "Zabihullah Kogyani" files under K. Lowercased for case-insensitive
 * comparison. A mononym sorts by its only token.
 *
 * Derived rather than stored — nothing has to be migrated if a surface adopts
 * it later. Note this is a heuristic on a single stored string, so it files a
 * family-name-first name under the wrong letter; that is the same tradeoff the
 * roster makes today by sorting on the raw `name`.
 */
export function sortKeyOf(p: { name: string }): string {
	const last = lastNameOf(p.name);
	const first = firstNameOf(p.name);
	return (last ? `${last} ${first}` : first).toLowerCase();
}

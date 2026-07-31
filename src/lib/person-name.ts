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

/**
 * The comparable tokens of a full name: lowercased, diacritic-folded, split on
 * whitespace AND punctuation, sorted.
 *
 * Sorting is what makes "Khan, Zabihullah" and "Zabihullah Khan" compare equal
 * without having to decide which token is the family name — a decision this
 * codebase deliberately refuses to make (see `firstNameOf`). Splitting on
 * punctuation rather than whitespace alone is what folds the comma shape and
 * "Abdul-Rasheed" / "Abdul Rasheed" together.
 *
 * The split class is `\p{P}\p{S}` (punctuation/symbols) and NOT `[^a-z0-9]`:
 * the latter erases any non-Latin script entirely, leaving zero tokens, which
 * would make `namesAgree` permanently false for those members instead of merely
 * imprecise.
 */
function nameTokens(name: string): string[] {
	return name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.split(/[\s\p{P}\p{S}]+/u)
		.filter(Boolean)
		.sort();
}

/**
 * Two name tokens are compatible if they are equal, or if one is an INITIAL
 * standing in for the other ("Jamie R." / "Jamie Rivera").
 *
 * Only a single letter counts as an abbreviation. General prefix matching would
 * fuse "Jane Doe" with "Janet Doe" and "Sam Doe" with "Sandra Doe" — distinct
 * humans who plausibly share a phone, which is the exact failure this guard
 * exists to prevent. It would also only half-work: this codebase already holds
 * that nicknames are NOT derivable from a stored name (a Robert goes by Bob —
 * see the `people.preferred_name` rationale in #486), so "Rob"/"Robert" is
 * treated as a mismatch rather than pretending prefixes model nicknames.
 */
function tokensMatch(a: string, b: string): boolean {
	if (a === b) return true;
	if (a.length === 1) return b.startsWith(a);
	if (b.length === 1) return a.startsWith(b);
	return false;
}

/**
 * Above this many tokens on either side, skip the pairing search entirely and
 * demand exact equality.
 *
 * `everyTokenPairs` backtracks, so its cost is FACTORIAL in the token count when
 * no complete pairing exists. That is fine for names and catastrophic for input
 * built to abuse it: `captureGuestVisit` is the public, unauthenticated guest
 * book, and measured on this code a pair of ~40-character names made of one
 * repeated token plus one that cannot pair costs 39ms at 10 tokens, 391ms at 11,
 * and 4.8s at 12 — synchronous, on the single Node event loop, inside an open
 * transaction. Two guest-book POSTs sharing a phone number reach it.
 *
 * 8 is far past any real name (the longest in the roster is 4 tokens) and caps
 * the search at 8! ≈ 40k steps, which is microseconds. Beyond it the comparison
 * gets STRICTER, not looser — exact match only — so the cap can never invent an
 * agreement that fuses two people.
 */
const MAX_MATCH_TOKENS = 8;

/** Sorted token lists compared element-wise. Bounded, and stricter than pairing. */
function tokensIdentical(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Whether every token of `shorter` can be paired with a DISTINCT token of
 * `longer`. Backtracks rather than matching greedily: pairing ["j","jane"]
 * against ["jane","john"] greedily burns `jane` on `j` and then fails, though a
 * valid pairing exists. Callers MUST bound the token count first — see
 * `MAX_MATCH_TOKENS` for why this is not free.
 */
function everyTokenPairs(shorter: string[], longer: string[]): boolean {
	const used = Array.from({ length: longer.length }, () => false);
	const assign = (i: number): boolean => {
		const token = shorter[i];
		if (token === undefined) return true;
		for (let j = 0; j < longer.length; j++) {
			const candidate = longer[j];
			if (used[j] || candidate === undefined) continue;
			if (!tokensMatch(token, candidate)) continue;
			used[j] = true;
			if (assign(i + 1)) return true;
			used[j] = false;
		}
		return false;
	};
	return assign(0);
}

/**
 * Whether two stored full names plausibly refer to the same human (#488).
 *
 * Used to qualify a phone-number match before two records are fused. A phone
 * number is a HOUSEHOLD fact, not an identity: spouses share a mobile, and a
 * guest-book row carrying a partner's number would otherwise dedupe onto the
 * wrong Person — taking that person's future speeches and Pathways enrollments
 * with it, since all three FKs are Person-scoped.
 *
 * The discriminating signal is the GIVEN name, not the whole string. The two
 * cases this has to separate look nothing alike once you notice that:
 *
 *   - Two humans on one phone are a family — they SHARE the surname and differ
 *     on the given name ("Jane Doe" / "John Doe"). Must not agree.
 *   - One human writing their own name twice differs only by TRUNCATION — a
 *     guest book gets "Jamie Rivera" one week and "Jamie R." the next, and
 *     middle names come and go. Must agree, or a returning visitor's history
 *     splits in two and the VP-Membership funnel undercounts them.
 *
 * So tokens pair up when either abbreviates the other, and the shorter name only
 * has to be covered by the longer. Requiring exact equality instead breaks the
 * returning-guest dedupe, which is a feature the club actively uses.
 *
 * Residual hole, accepted: an initial-only entry ("J Doe") is genuinely
 * ambiguous between two family members and will pair with the older row. That
 * is strictly better than today, where the name is not consulted at all.
 *
 * A name with no comparable tokens (empty, whitespace, punctuation only) agrees
 * with nothing, including another empty name.
 */
export function namesAgree(a: string, b: string): boolean {
	const ta = nameTokens(a);
	const tb = nameTokens(b);
	if (ta.length === 0 || tb.length === 0) return false;
	if (ta.length > MAX_MATCH_TOKENS || tb.length > MAX_MATCH_TOKENS) {
		return tokensIdentical(ta, tb);
	}
	return ta.length <= tb.length
		? everyTokenPairs(ta, tb)
		: everyTokenPairs(tb, ta);
}

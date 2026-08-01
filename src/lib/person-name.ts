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
 * Longest stored name this will tokenize.
 *
 * The comparison's other side comes from `guests.name` / `people.name`, and not
 * every path that writes those caps its input. Bounding here keeps the pure
 * function safe no matter which caller reaches it: a 400KB stored name costs
 * ~22ms per call in NFD-normalize and regex alone, before any pairing runs.
 */
const MAX_NAME_CHARS = 200;

/**
 * The comparable tokens of a full name: lowercased, diacritic-folded, split on
 * whitespace and hyphens, inner punctuation stripped, sorted.
 *
 * Sorting is what makes "Khan, Zabihullah" and "Zabihullah Khan" compare equal
 * without having to decide which token is the family name — a decision this
 * codebase deliberately refuses to make (see `firstNameOf`).
 *
 * Separators and inner punctuation are deliberately NOT the same thing. Hyphens
 * separate ("Abdul-Rasheed" reads as "Abdul Rasheed"); an apostrophe does not.
 * Splitting on ALL punctuation turned "D'Angelo" into ["d", "angelo"], and that
 * stray "d" then acted as an initial matching any D-name — "David Russo" agreed
 * with "D'Angelo Russo". Strip inner punctuation instead, so the token is
 * "dangelo" and no wildcard is manufactured.
 *
 * Stripping rather than splitting on `\p{P}\p{S}` also preserves non-Latin
 * scripts, which a `[^a-z0-9]` class would erase to zero tokens — making
 * `namesAgree` permanently false for those members rather than merely imprecise.
 */
function nameTokens(name: string): string[] {
	return name
		.slice(0, MAX_NAME_CHARS)
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.split(/[\s\u002d\u2010-\u2015]+/u)
		.map((t) => t.replace(/[\p{P}\p{S}]/gu, ""))
		.filter(Boolean)
		.sort();
}

/**
 * Two name tokens are compatible if they are equal, or — when `allowInitials` —
 * if one is a single letter standing in for the other ("Jamie R." / "Jamie
 * Rivera").
 *
 * Only a single letter abbreviates. General prefix matching would fuse "Jane
 * Doe" with "Janet Doe" and "Sam Doe" with "Sandra Doe" — distinct humans who
 * plausibly share a phone, the exact failure this guard exists to prevent. It
 * would also only half-work: this codebase holds that a nickname is NOT
 * derivable from a stored name (a Robert goes by Bob — see the
 * `people.preferred_name` rationale in #486), so "Rob"/"Robert" stays a
 * mismatch rather than pretending prefixes model nicknames.
 */
function tokensMatch(a: string, b: string, allowInitials: boolean): boolean {
	if (a === b) return true;
	if (!allowInitials) return false;
	if (a.length === 1) return b.startsWith(a);
	if (b.length === 1) return a.startsWith(b);
	return false;
}

/**
 * Above this many tokens on either side, skip the pairing search and demand
 * exact equality. 8 is far past any real name (the longest on the roster is 4).
 *
 * Beyond the cap the comparison gets STRICTER, not looser — exact match only —
 * so the bound can never invent an agreement that fuses two people.
 */
const MAX_MATCH_TOKENS = 8;

/** Sorted token lists compared element-wise. Bounded, and stricter than pairing. */
function tokensIdentical(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Whether every token of `shorter` can be paired with a DISTINCT token of
 * `longer` — maximum bipartite matching, via Kuhn's augmenting-path algorithm.
 *
 * Greedy pairing is wrong: ["j","jane"] against ["jane","john"] burns `jane` on
 * `j` and then fails, though a valid pairing exists. The obvious repair is to
 * backtrack, and that is what this did — but backtracking is FACTORIAL when no
 * complete pairing exists, and both sides of this comparison are attacker-
 * supplied through the public guest book. Measured on the backtracking version:
 * 39ms at 10 tokens, 391ms at 11, 4.8s at 12, synchronous, on the single Node
 * event loop, inside an open transaction — and `findGuestByContact` runs it once
 * per same-phone candidate.
 *
 * Kuhn's gives the same answer in O(V·E): each augmenting search visits every
 * right-hand token at most once (`seen`), and a matched token is re-assigned by
 * recursing on its current owner rather than by unwinding the whole prefix.
 */
function everyTokenPairs(
	shorter: string[],
	longer: string[],
	allowInitials: boolean,
): boolean {
	// matchOf[j] = index into `shorter` currently holding longer[j], or -1.
	const matchOf: number[] = Array.from({ length: longer.length }, () => -1);

	const augment = (i: number, seen: boolean[]): boolean => {
		const token = shorter[i];
		if (token === undefined) return false;
		for (let j = 0; j < longer.length; j++) {
			const candidate = longer[j];
			if (seen[j] || candidate === undefined) continue;
			if (!tokensMatch(token, candidate, allowInitials)) continue;
			seen[j] = true;
			const owner = matchOf[j];
			if (owner === undefined || owner === -1 || augment(owner, seen)) {
				matchOf[j] = i;
				return true;
			}
		}
		return false;
	};

	for (let i = 0; i < shorter.length; i++) {
		const seen = Array.from({ length: longer.length }, () => false);
		if (!augment(i, seen)) return false;
	}
	return true;
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
 *     guest book gets "Jamie Rivera" one week and "Jamie R." the next. Must
 *     agree, or a returning visitor's history splits in two and the
 *     VP-Membership funnel undercounts them.
 *
 * **Initials only count when the two names have the SAME number of tokens.**
 * A single letter is a wildcard, and an unguarded wildcard defeats the whole
 * check: `namesAgree("Jane Doe", "j")` was true, so a guest-book row named "J"
 * carrying a member's household number converted straight onto that member —
 * the very bug this function was added to stop. It is not only a lazy attacker:
 * a standalone particle is a real token in real names, so "Ana Silva e Costa"
 * agreed with "Eduardo Silva Costa" (the "e" absorbed "Eduardo") and "Maria
 * Garcia y Lopez" with "Yolanda Garcia Lopez". Requiring equal token counts
 * keeps "Jamie R." working while closing all of those, because an abbreviation
 * replaces a token rather than removing one.
 *
 * Residual, accepted: a name that is ONLY a shared surname ("Doe") still agrees
 * with "Jane Doe" and would take the older row. Deciding that "Doe" is a family
 * name is exactly the inference `firstNameOf` documents this codebase as
 * refusing to make, and it needs a guest to write a surname and nothing else.
 * Still strictly better than the old behaviour, where the name was not consulted.
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
	// An initial SUBSTITUTES for a token; it never removes one. So a differing
	// token count means the shorter name dropped a token, not abbreviated it.
	const allowInitials = ta.length === tb.length;
	return ta.length <= tb.length
		? everyTokenPairs(ta, tb, allowInitials)
		: everyTokenPairs(tb, ta, allowInitials);
}

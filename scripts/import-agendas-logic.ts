export type RosterMember = {
	memberId: string;
	personId: string;
	name: string;
};

/** Lowercase, strip a trailing "(G)" guest marker, collapse whitespace, trim. */
export function normalizeName(raw: string): string {
	return raw
		.replace(/\(g\)/gi, " ")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/** Classic Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	let curr = new Array<number>(n + 1);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

export type MatchResult = {
	member?: RosterMember;
	/** Roster names within edit-distance 2, offered when there is no confident match. */
	suggestions: string[];
};

/**
 * Resolve a raw agenda name to a roster member.
 * Order: alias map → exact normalized → unique typo at distance ≤1 → no match
 * (with distance-≤2 names surfaced as suggestions). Never matches ambiguously.
 * `aliases` keys are normalized raw names; values are canonical roster names.
 */
export function matchMember(
	raw: string,
	roster: RosterMember[],
	aliases: Record<string, string>,
): MatchResult {
	const norm = normalizeName(raw);
	const aliased = aliases[norm];
	const target = aliased ? normalizeName(aliased) : norm;

	const exact = roster.find((m) => normalizeName(m.name) === target);
	if (exact) return { member: exact, suggestions: [] };

	const scored = roster
		.map((m) => ({ m, d: levenshtein(target, normalizeName(m.name)) }))
		.sort((a, b) => a.d - b.d);

	const atOne = scored.filter((s) => s.d <= 1);
	if (atOne.length === 1) return { member: atOne[0].m, suggestions: [] };

	const suggestions = scored.filter((s) => s.d <= 2).map((s) => s.m.name);
	return { member: undefined, suggestions };
}

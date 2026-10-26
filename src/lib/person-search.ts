/**
 * The one person matcher (#1331, part of #1320). Pure and client-safe.
 *
 * Case- and accent-insensitive, every query word must prefix some name word in
 * any order, substring as the fallback. No fuzzy matching.
 */
import { firstNameOf, nameWords } from "./person-name";

export interface SearchablePerson {
	name: string;
	preferredName?: string | null;
	/** Extra strings to match (officer labels, an email). Optional. */
	extraTerms?: readonly string[];
}

/** 0 exact, 1 prefix, 2 word-prefix, 3 substring. */
export type MatchTier = 0 | 1 | 2 | 3;

const MAX_QUERY_WORDS = 8;

interface FoldedQuery {
	words: string[];
	joined: string;
}

function foldQuery(query: string): FoldedQuery | null {
	const words = nameWords(query).slice(0, MAX_QUERY_WORDS);
	if (words.length === 0) return null;
	return { words, joined: words.join(" ") };
}

function tierOf(q: FoldedQuery, person: SearchablePerson): MatchTier | null {
	const candidates: string[][] = [nameWords(person.name)];
	if (person.preferredName?.trim()) {
		candidates.push(nameWords(person.preferredName));
	}
	for (const t of person.extraTerms ?? []) candidates.push(nameWords(t));

	const folded = candidates.map((w) => w.join(" "));
	if (folded.some((c) => c === q.joined)) return 0;
	if (folded.some((c) => c.startsWith(q.joined))) return 1;
	const union = candidates.flat();
	if (q.words.every((qw) => union.some((w) => w.startsWith(qw)))) return 2;
	if (folded.some((c) => c.includes(q.joined))) return 3;
	return null;
}

/** True when the query folds to no words (empty, blank or punctuation-only): it lists everyone. */
export function isBlankQuery(query: string): boolean {
	return foldQuery(query) === null;
}

/** Best tier across the person's strings, or null for no match. Empty/blank query is 0. */
export function matchTier(
	query: string,
	person: SearchablePerson,
): MatchTier | null {
	const q = foldQuery(query);
	return q ? tierOf(q, person) : 0;
}

/**
 * Matching rows, sorted by rank(p) asc, then tier asc, then name.localeCompare,
 * then input order (Array.prototype.sort is stable). Non-matching rows are dropped.
 */
export function searchPeople<T extends SearchablePerson>(
	query: string,
	people: readonly T[],
	options?: { rank?: (p: T) => number },
): T[] {
	const q = foldQuery(query);
	const rank = options?.rank ?? (() => 0);
	const rows: { p: T; r: number; t: MatchTier; i: number }[] = [];
	people.forEach((p, i) => {
		const t = q ? tierOf(q, p) : 0;
		if (t !== null) rows.push({ p, r: rank(p), t, i });
	});
	rows.sort(
		(a, b) => a.r - b.r || a.t - b.t || a.p.name.localeCompare(b.p.name),
	);
	return rows.map((x) => x.p);
}

/**
 * The preferred name to show as "goes by X", or null when it is blank or folds
 * equal to the first name. The caller renders "goes by".
 */
export function goesBy(person: {
	name: string;
	preferredName?: string | null;
}): string | null {
	const preferred = person.preferredName?.trim();
	if (!preferred) return null;
	const fold = (s: string) => nameWords(s).join(" ");
	if (fold(preferred) === fold(firstNameOf(person.name))) return null;
	return preferred;
}

/**
 * Most of the other club's guests ranked per guest-link search, by (name, id).
 * A documented ceiling: a club with more guests is searched over its first 1000
 * (#1333). A number, so it lives here and not beside the db import.
 */
export const GUEST_LINK_SEARCH_POOL = 1000;

/** Fold an email's local part into search words: split on `.`, `_`, `+`; the domain never matches. */
export function emailSearchTerms(email: string): string {
	return (email.split("@")[0] ?? "").split(/[._+]/).filter(Boolean).join(" ");
}

/**
 * The email-shaped reading of a query, or null when the query has no `@`, `.`,
 * `_` or `+` (a plain name query) or nothing is left of its local part. Same
 * rule as `emailSearchTerms`, so "j.doe" and "j.doe@gm" agree with `j.doe@…`.
 */
export function emailQueryTerms(query: string): string | null {
	if (!/[@._+]/.test(query)) return null;
	const terms = emailSearchTerms(query.trim());
	return terms && !isBlankQuery(terms) ? terms : null;
}

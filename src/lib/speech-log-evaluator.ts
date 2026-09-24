/**
 * The evaluator line of one speech-log row (#681), in one place.
 *
 * Both speech logs render it — the dashboard's (every club the user is in) and
 * the member profile's (one club) — and before this module each wrote its own
 * wording inline, so the profile hid the evaluator for any Pathways speech
 * while the dashboard said "evaluated by" about a speech not yet given.
 *
 * Pure and `#/db`-free: the row type is imported with `import type`, so nothing
 * from the query module reaches the client bundle.
 */
import type { SpeechLogEvaluator } from "#/server/my-activity-logic";

/** A guest evaluator's display name — the VPE dashboard's wording too. */
function displayName(e: SpeechLogEvaluator): string {
	return e.isGuest ? `${e.name} (guest)` : e.name;
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the row says about its evaluator, or `null` for nothing at all.
 *
 * - past, held: `Evaluated by Ana` / `Evaluated by Ana and Jane Doe (guest)`
 * - upcoming, held: `Evaluator: Ana` / `Evaluators: Ana and Jane Doe (guest)`
 * - upcoming, slot exists but nobody holds it: `Evaluator not yet assigned`
 * - past with an unheld slot, or no evaluator slot in either tense: `null` —
 *   "nobody evaluated this" about a delivered speech is not something the log
 *   can know (the evaluation may have happened off-agenda).
 *
 * `isUpcoming` is the caller's `speechScheduleState(...) === "scheduled"`
 * against the loader-pinned `now`, never the wall clock here.
 */
export function speechLogEvaluatorLabel(input: {
	evaluators: SpeechLogEvaluator[];
	hasEvaluatorSlot: boolean;
	isUpcoming: boolean;
}): string | null {
	const { evaluators, hasEvaluatorSlot, isUpcoming } = input;
	if (evaluators.length > 0) {
		const names = joinNames(evaluators.map(displayName));
		if (!isUpcoming) return `Evaluated by ${names}`;
		return `${evaluators.length === 1 ? "Evaluator" : "Evaluators"}: ${names}`;
	}
	if (hasEvaluatorSlot && isUpcoming) return "Evaluator not yet assigned";
	return null;
}

/** The search params both speech-log routes accept: `?speeches=all` or none. */
export interface SpeechLogSearch {
	speeches?: "all";
}

/**
 * `validateSearch` for the two speech-log routes. Anything but the literal
 * `"all"` drops to `undefined`, i.e. the newest-6 default.
 */
export function validateSpeechLogSearch(
	search: Record<string, unknown>,
): SpeechLogSearch {
	return search.speeches === "all" ? { speeches: "all" } : {};
}

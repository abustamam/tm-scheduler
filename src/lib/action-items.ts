// Pure, client-safe action-item selectors (#529). NO `#/db` import, so these
// and the caps beside them are unit-testable without a database.
//
// These two functions are the correctness heart of the feature. Minutes are a
// HISTORICAL RECORD, but "which action items are open" is a LIVE query. Render
// the live list into a meeting's minutes and the record rewrites itself: email
// March's minutes in April and they show April's state; regenerate last year's
// and they are simply wrong.
//
// The fix is to reconstruct from timestamps rather than read current state. An
// item carries when it was raised and when (if ever) it was resolved, and a
// meeting's minutes ask "what was open at THIS instant". That answer never
// changes, so a past meeting renders identically today, next month and next
// year.
//
// Note this needs no foreign key to a meeting at all, which is what lets an
// item raised in a hallway between meetings land in the right place on the
// timeline.

/** The timestamps every selector here reasons over. */
export interface ActionItemFact {
	createdAt: Date;
	resolvedAt: Date | null;
}

/**
 * The items that were open at `instant` — raised on or before it, and either
 * still unresolved or resolved strictly after it.
 *
 * Boundaries are deliberate and pinned by tests. An item raised exactly at the
 * meeting instant counts as open (it was raised AT that meeting); one resolved
 * exactly at the instant counts as closed (it was closed AT that meeting, and
 * belongs in the resolved list instead). Without that split a single item can
 * appear in both lists, or neither.
 *
 * Oldest first, so the thing that has been outstanding longest leads — which is
 * the order it should be read out in.
 */
export function openAsOf<T extends ActionItemFact>(
	items: T[],
	instant: Date,
): T[] {
	return items
		.filter(
			(i) =>
				i.createdAt <= instant &&
				(i.resolvedAt === null || i.resolvedAt > instant),
		)
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * The items resolved in `(from, to]` — the "closed since we last met" list.
 *
 * `from` is null for a club's first-ever minutes, which opens the window at the
 * beginning of time rather than returning nothing. Most recently resolved
 * first.
 */
export function resolvedBetween<T extends ActionItemFact>(
	items: T[],
	from: Date | null,
	to: Date,
): T[] {
	return items
		.filter(
			(i): i is T & { resolvedAt: Date } =>
				i.resolvedAt !== null &&
				i.resolvedAt <= to &&
				(from === null || i.resolvedAt > from),
		)
		.sort((a, b) => b.resolvedAt.getTime() - a.resolvedAt.getTime());
}

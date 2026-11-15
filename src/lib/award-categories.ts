/**
 * The award categories (#152, #1635): the ONE list of their values.
 *
 * The pg enum `award_category` (`schema.ts`) is built from `AWARD_CATEGORIES`,
 * and `BeatAwardCategory` is derived from it, so the two cannot drift. A module
 * of its own, importing nothing: the run sheet reaches the client-only /timer
 * route, which must not import `#/db` (`timer-route.guard.test.ts`).
 *
 * The ORDER is the enum's, and so the generated SQL's: reordering it would
 * emit a different `CREATE TYPE`.
 */
export const AWARD_CATEGORIES = [
	"best_speaker",
	"best_evaluator",
	"best_table_topics",
] as const;

/** The award a vote beat calls for (#1635). */
export type BeatAwardCategory = (typeof AWARD_CATEGORIES)[number];

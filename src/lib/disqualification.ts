import { z } from "zod";
import { cap } from "./cap";

/**
 * Length cap on the REASON a candidate was disqualified from an award (#723).
 *
 * Lives in `lib/`, not beside either consumer, for the two reasons
 * `write-in-limits.ts` and `club-logo-limits.ts` already state. First: a
 * constant defined in a module that imports `#/db` at load is unassertable,
 * because a unit test importing it throws `DATABASE_URL is not set` — #522
 * shipped its caps inside the renderer, where they could have been raised to
 * 5,000,000 with the whole suite green. Second: the CLIENT has to agree about
 * this number (the console's free-text field mirrors it as `maxLength`), and a
 * number the client needs cannot live server-side without being re-declared
 * there, which is how the club-logo caps drifted into four spellings.
 *
 * 120 code points, chosen against what the string has to DO rather than picked
 * round. It is one clause explaining a ruling — "Spoke outside the qualifying
 * window" is 38 — and it renders beside a name on a phone-width ballot card,
 * where a second wrapped line is already pushing it. Far smaller than
 * `WRITE_IN_LIMITS.name`'s reasoning needs to be, because unlike a name this
 * is written by an AUTHENTICATED-or-self-asserted Vote Counter rather than by
 * anyone holding the ballot link: the row bound is one per candidate per
 * category, and it reaches no synchronous PDF renderer (#723 keeps
 * disqualification off the printed agenda and the projected deck entirely).
 * The absolute ceiling is pinned by `disqualification-limits.guard.test.ts`
 * rather than stated relative to itself — an assertion written as
 * `<= DISQUALIFICATION_LIMITS.reason` passes for every value of it, including
 * one that reintroduces the bug.
 */
export const DISQUALIFICATION_LIMITS = {
	/** The reason shown on the ballot beside a struck-through name. */
	reason: 120,
} as const;

/**
 * The write path's validator: TRIMS, then REJECTS over the cap.
 *
 * Rejects rather than truncating, matching `writeInNameSchema` and for the
 * same reason: the field IS the whole input, a truncated reason can change
 * what it says, and the Vote Counter is looking at the form and able to fix
 * it. `.trim()` runs before `.max()` so trailing whitespace can never push an
 * otherwise-valid reason over, and `.min(1)` after the trim is what makes the
 * column's NOT NULL mean something — a reason of nothing but spaces would
 * satisfy the database and tell the room nothing.
 */
export const disqualificationReasonSchema = z
	.string()
	.trim()
	.min(1, "Give a reason.")
	.max(DISQUALIFICATION_LIMITS.reason, "That reason is too long.");

/**
 * The RENDER-side cap, for the PUBLIC ballot.
 *
 * The write path caps too, so this is defence in depth — the same shape
 * `loadWriteInCandidates` uses on `candidate_write_in`, and for the same
 * reason: the column is unbounded `text`, this is a fully public surface, and
 * a row written by any future path that forgets the schema should be elided
 * here rather than shipped to every phone in the room. Goes through the
 * audited `cap`, never `.slice()`, which cuts surrogate pairs in half (#522).
 */
export function capDisqualificationReason(reason: string): string {
	return cap(reason, DISQUALIFICATION_LIMITS.reason);
}

/**
 * The two rulings the Timer's own script already describes, offered as one tap
 * in the Vote Counter's console.
 *
 * Presets, not an enum: the column is free text because a club will have a
 * third reason nobody anticipated, and a closed vocabulary would push that
 * into "Other" — which is the console-only flag this feature exists to
 * replace. These are the common cases made cheap, not the allowed set.
 */
export const DISQUALIFICATION_PRESETS = [
	"Spoke outside the qualifying window",
	"Did not use the Word of the Day",
] as const;

import { z } from "zod";
import { cap } from "./cap";

/**
 * Length cap on a write-in candidate's name (#582).
 *
 * THIS IS THE MOST EXPOSED FREE-TEXT FIELD IN THE PRODUCT, and the cap is why
 * it is safe to have one. Every other user-authored string that reaches a
 * printed or projected surface is written by someone who at minimum picked
 * their name off a club roster: the Word of the Day is set by an officer, a
 * speech title by the speaker holding the slot, an action item by whoever is
 * in the minutes screen. A write-in is typed by ANYONE holding the ballot
 * link, with no session, and lands on:
 *
 *   - the projected awards slide, in front of the whole room;
 *   - `meeting_awards`, and from there the minutes, the emailed minutes and
 *     `/api/meetings/:id/minutes.pdf`, which `@react-pdf/renderer` lays out
 *     SYNCHRONOUSLY inside the one Node process serving everything else
 *     (ADR-0007);
 *   - the ballot itself, echoed back to every later voter as a tappable
 *     option (see `loadBallot`).
 *
 * So it is the #519/#522 shape exactly: unauthenticated input reaching a
 * synchronous server-side renderer. The number is small because a NAME is
 * small — the longest `members.name` in dev data is 34 characters, and this
 * sits ~2x above the longest plausible real one rather than the ~10x the Word
 * of the Day fields use, because unlike a definition there is no legitimate
 * long value to accommodate.
 *
 * WHY A LENGTH CAP IS NOT ENOUGH ON ITS OWN, and what actually bounds the
 * cost: #522 measured emoji costing ~13x ASCII through the same renderer at
 * the same capped length, so a cap in CODE POINTS does not bound render time.
 * The bound here is length x rows: one write-in per voter per category, and
 * the ballot's guest cap (`meeting_ballot_guests`, #510) already bounds
 * voters. 80 code points against that row bound is far below the knee #519
 * measured (500 and 5,000 characters both rendered in 39ms; 49,999 took
 * 3,707ms), which is the measurement this number is chosen against rather
 * than picked round.
 *
 * Lives in `lib/`, not beside either consumer, for the reason
 * `speaker-limits.ts` and `minutes-render-caps.ts` do: a constant defined in a
 * module that imports `#/db` at load is unassertable, because a unit test
 * importing it throws `DATABASE_URL is not set`. #522 shipped its caps inside
 * the renderer first, where they could have been raised to 5,000,000 with the
 * whole suite green — inside the very change that cited the trap.
 */
export const WRITE_IN_LIMITS = {
	/** A candidate's name, as typed on the public ballot. */
	name: 80,
} as const;

/**
 * The write path's validator: TRIMS, then REJECTS over the cap.
 *
 * Rejects rather than truncating, which is the opposite of `WOD_UPDATE_FIELDS`
 * and deliberately so. Truncation is right when silently shortening beats
 * locking someone out of an unrelated form; here the field IS the whole input,
 * a truncated name is a different person, and the voter is standing there able
 * to fix it. A clear error costs one retype; a silent truncation puts "Bartholo"
 * on the awards slide.
 *
 * `.trim()` runs BEFORE `.max()` so trailing whitespace can never push an
 * otherwise-valid name over, and `.min(1)` after the trim rejects a name that
 * is nothing but whitespace — which would otherwise become an invisible
 * candidate nobody could tell apart from another invisible candidate.
 */
export const writeInNameSchema = z
	.string()
	.trim()
	.min(1, "Enter a name.")
	.max(WRITE_IN_LIMITS.name, "That name is too long.");

/**
 * The RENDER-side cap, for surfaces that must not fail on a row written before
 * this cap existed (or by a future path that forgets the schema).
 *
 * Goes through the audited `cap` rather than `.slice()`: a UTF-16 slice cuts
 * surrogate pairs in half, and #522 measured node-postgres UTF-8-encoding the
 * resulting lone surrogate to U+FFFD — corrupting the value at exactly the cap,
 * so a later render-side check passes it through onto a public PDF.
 */
export function capWriteInName(name: string): string {
	return cap(name, WRITE_IN_LIMITS.name);
}

/**
 * The key two write-ins are considered THE SAME PERSON under.
 *
 * Dedup here is by VISIBILITY, not by matching: the ballot shows write-ins
 * already cast in this session as tappable options, so the second voter for
 * the same person taps the existing entry instead of retyping a variant. This
 * key is what groups those options — without it "bob smith" and "Bob Smith"
 * present as two candidates and split the vote, which is the failure mode a
 * free-text ballot has and a roster-backed one does not.
 *
 * Case-folded and whitespace-collapsed, NOT punctuation-stripped. Collapsing
 * internal runs of whitespace matters because the input is typed on a phone,
 * where a double space is invisible and common. Punctuation is left alone on
 * purpose: "O'Brien" and "OBrien" are plausibly different people and this is
 * not the place to guess. The DISPLAY form is always the first spelling cast,
 * never this key — nobody should see their name lowercased on the awards slide.
 */
export function writeInKey(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, " ");
}

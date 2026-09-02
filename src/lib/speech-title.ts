/**
 * What counts as a REAL speech title, in one place (#660).
 *
 * `speeches.title` is `NOT NULL`, so "no title yet" cannot be stored as NULL.
 * The app stores the literal `"TBA"` instead — `updateSpeakerDetails` documents
 * "Blank title → TBA", and `edit-speech-sheet.tsx` uses it as the input's own
 * placeholder — and `normalizeSpeech` then treats that value as *unset* when
 * deciding whether a speech row is worth creating at all. So the sentinel is a
 * real part of the data model, and a reader that only asks "is this string
 * non-blank?" gets the wrong answer for the single most common way a speaker
 * leaves their title undecided.
 *
 * This lives in `src/lib` rather than beside `normalizeSpeech` for the reason
 * CLAUDE.md gives (#519/#522): `slots-logic.ts` imports the database layer, so
 * a predicate defined there is unreachable from a unit test AND unimportable
 * from a client route. The duty registry needs both.
 */

/** The stored stand-in for "no title decided yet". A derived, unstored state
 *  everywhere except `speeches.title`, which cannot hold NULL. */
export const TBA_SPEECH_TITLE = "TBA";

/**
 * True when a speaker has actually named their speech.
 *
 * Blank, whitespace-only and the `TBA` sentinel are all NOT real, which is
 * exactly `normalizeSpeech`'s own `hasRealTitle` rule — it trims first, so
 * `"  TBA  "` is a placeholder too (`slots-logic.test.ts`). Case is NOT folded,
 * matching that rule precisely: a speaker who types a lower-case `tba` has it
 * stored as a real title today, and quietly disagreeing with the write path
 * here would put this module's answer at odds with the agenda's.
 */
export function isRealSpeechTitle(title: string | null | undefined): boolean {
	const trimmed = title?.trim() ?? "";
	return trimmed.length > 0 && trimmed !== TBA_SPEECH_TITLE;
}

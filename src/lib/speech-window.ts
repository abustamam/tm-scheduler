// How long is this speech? (#394) — the two answers, one definition each.
//
// `minMinutes` and `maxMinutes` are independently nullable columns, so every
// surface that says anything about a speech's length had to decide for itself
// what a half-filled pair meant — and they disagreed three ways for a slot with
// Min 5 and Max blank: the deck projected "Time: 5 minutes", the run sheet
// booked `maxMinutes ?? DEFAULT_SPEAKER_MINUTES` = 7 for the same row (shifting
// every later printed row's clock), and the marks and #357's qualifying window
// rendered nothing.
//
// TWO functions, deliberately, because there are two questions and they have
// different answers:
//
//   `speechWindow`        — what the club ASSIGNED as a range. Needs both ends.
//   `speechBookedMinutes` — how long the SCHEDULE reserves. Needs only a max.
//
// The temptation is to collapse them: have one "is this slot configured?" rule
// and let the booked duration fall back to the house default whenever it says
// no. **The max-only slot is why not.** A club that typed Max 6 and left Min
// blank has no range — nothing to signal green·yellow·red against, nothing for
// the grace window to bracket — but it has said exactly how much of the meeting
// this speech gets. Booking `DEFAULT_SPEAKER_MINUTES` there would discard a
// number the club typed and reserve more time than they asked for, which is the
// same sin as the original bug in reverse: a duration on the sheet that nobody
// entered. So the two questions stay separate, and the invariant that actually
// matters — the deck's "Time:" line and the printed clock agreeing — is kept by
// having BOTH read `speechBookedMinutes`, not by making them share a gate.

/** A speech's assigned time range, in minutes. Always BOTH ends. */
export type SpeechWindow = {
	/** Lower bound — the green light. */
	min: number;
	/** Upper bound — the red light. */
	max: number;
};

/** The two slot/speech columns a window is derived from. */
export type SpeechWindowInput = {
	minMinutes?: number | null;
	maxMinutes?: number | null;
};

/**
 * THE assigned RANGE (#394) — one definition, every surface that shows a span.
 *
 * `null` unless BOTH ends are present, finite and ordered. A range has two
 * edges: a slot with only a minimum, only a maximum, or a max below its min has
 * no range, and the surfaces that need one — the Timer's green·yellow·red marks,
 * #357's qualifying window, the agenda card's "· 5–7 min" chip — must render
 * nothing rather than invent the missing edge. Filling a blank max with
 * `min + span` is exactly the kind of number-nobody-typed this issue is about.
 *
 * This does NOT answer "how many minutes does this speech get on the clock" —
 * see `speechBookedMinutes`, and the note at the top of this file for why a
 * max-only slot means the two questions cannot share one answer.
 */
export function speechWindow(
	slot: SpeechWindowInput | null | undefined,
): SpeechWindow | null {
	const min = slot?.minMinutes;
	const max = slot?.maxMinutes;
	if (min == null || max == null) return null;
	if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
	if (max < min) return null;
	return { min, max };
}

/** Minutes a speaker beat reserves when the slot names no maximum. */
export const DEFAULT_SPEAKER_MINUTES = 7;

/**
 * THE booked duration (#394) — how much of the meeting this speech gets.
 *
 * The slot's maximum whenever it has one, falling back to the house default
 * when it doesn't. A minimum is NOT a maximum, so a min-only slot books the
 * default — that was the reported bug, where the deck projected the minimum as
 * though it were the whole allowance. A max-only slot books the max the club
 * typed: it has no *range*, but it has an unambiguous *allowance*, and
 * substituting the default there would discard a number they entered.
 *
 * Both the deck's "Time:" line and the printed run sheet's clock read this, so
 * the two agree by construction — which is the invariant #394 exists to hold.
 */
export function speechBookedMinutes(
	slot: SpeechWindowInput | null | undefined,
): number {
	const max = slot?.maxMinutes;
	return max != null && Number.isFinite(max) ? max : DEFAULT_SPEAKER_MINUTES;
}

/** Shown when exactly one of Min/Max is filled in. */
export const SPEECH_WINDOW_HALF_PAIR_MESSAGE =
	"Set both Min and Max minutes, or leave both blank.";

/** Shown when Min is above Max. */
export const SPEECH_WINDOW_ORDER_MESSAGE =
	"Min minutes can't be more than Max minutes.";

/**
 * The WRITE-side counterpart: the message to show for an unacceptable
 * Min/Max pair, or `null` when the pair is fine (both blank, or a real range).
 *
 * Required or neither, never one (#394). Both edit surfaces call this before
 * submitting and the server's `speakerDetailsSchema` refines on it — the server
 * check is not redundant, because speech details are reachable from the public
 * no-auth path where the client is not a guarantee of anything.
 */
export function speechWindowInputError(
	minMinutes: number | null | undefined,
	maxMinutes: number | null | undefined,
): string | null {
	const hasMin = minMinutes != null && Number.isFinite(minMinutes);
	const hasMax = maxMinutes != null && Number.isFinite(maxMinutes);
	if (hasMin !== hasMax) return SPEECH_WINDOW_HALF_PAIR_MESSAGE;
	if (hasMin && hasMax && (minMinutes as number) > (maxMinutes as number)) {
		return SPEECH_WINDOW_ORDER_MESSAGE;
	}
	return null;
}

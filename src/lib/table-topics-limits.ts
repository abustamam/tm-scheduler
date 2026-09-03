// src/lib/table-topics-limits.ts
//
// A club's own Table Topics speaking limits (#443), and the three derivations
// every surface reads them through.
//
// ## The problem this closes
//
// MCF prints "1 min min, 2.3 min max, 2.31+ disqualified" on its agenda; the
// deck said "1–2 minutes per speaker" and the run sheet's timer marks said red
// at 2:00. A Table Topics Master reading the screen and a Timer reading the row
// were being told different numbers for the same segment.
//
// This module reconciles the surfaces that render a MEETING: the projected deck
// (`agenda-slides.ts`), the printed run sheet and on-screen agenda (both via
// `resolveAgendaRows`), and a materialised template's frozen marks
// (`agenda-materialise.ts`).
//
// The Timer's printed ROLE SHEET is covered too, and an earlier version of this
// header said it was not — on the stated ground that role sheets are
// "club-agnostic artifacts built by `scripts/build-role-sheets.ts` and committed
// as PDFs". Half true, and the wrong half: `role-sheet-layout.ts` is ONE layout
// serving both the committed blanks and the per-meeting sheets rendered by
// `api/meetings.$id.role-sheets.$sheet.pdf.ts`, which already carry the club's
// name, logo and role vocabulary (#520). So the excluded surface was the one
// person the whole feature exists for: a club that set 2:30 printed an agenda
// row saying 2:30 and handed the Timer a sheet saying red at 2:00, with a
// spoken script telling them to say the wrong number out loud.
//
// `STANDARD_TIMING_WINDOWS` is still the source for a club that has stated
// nothing, and the committed blanks are unchanged — they serve every club, so
// they cannot adopt one club's rule. See `standardTimingRows`.
//
// `agenda-runsheet.ts` named this upgrade before it existed: its constants sat
// behind a name instead of inline in the beat table specifically so a per-club
// override could fall back to them. This module is that override.
//
// ## Why the constants live HERE and not beside their consumers
//
// `agenda-runsheet.ts` (the run sheet) and `agenda-slides.ts` (the deck) both
// need them, and the run sheet needs this module's resolver — so defining the
// defaults there and importing them here would close a cycle. `agenda-runsheet`
// re-exports `TABLE_TOPICS_MARKS` for the call sites that already read it from
// there, exactly as it already re-exports `DEFAULT_SPEAKER_MINUTES`.
//
// ## Seconds in, minutes out
//
// The stored columns are SECONDS because the rule this exists to express is
// 2:30, and `TimingMarks` is float minutes — 2.5 is representable, but a club
// admin typing "2.5" to mean two and a half minutes is a worse form than
// minutes-and-seconds, and rounding a typed 2.3 (which MCF's printed sheet
// literally says, meaning 2:30) would silently store 2:18. Seconds are exact at
// the boundary and convert once, here.
import type { TimingMarks } from "./agenda-runsheet";

/**
 * The standard Toastmasters Table Topics window, used by every club that has
 * not stated its own. Moved here from `agenda-runsheet.ts` (which re-exports
 * it) so both render surfaces can reach it without a cycle.
 */
export const TABLE_TOPICS_MARKS: TimingMarks = {
	green: 1,
	yellow: 1.5,
	red: 2,
};

/** What the deck says when the club has stated no limits of its own. */
export const TABLE_TOPICS_DEFAULT_TIMING = "1–2 minutes per speaker";

/**
 * Absolute ceiling on a stored bound, in seconds (10 minutes).
 *
 * An ABSOLUTE number, not one derived from anything, because CLAUDE.md's rule
 * is that a test stated relative to the constant it guards cannot fail.
 *
 * Ten minutes is four times the longest Table Topics answer any club runs, and
 * it EQUALS the segment's own default budget (`minutes: 10` on the Table Topics
 * beat) — so a cap at the ceiling already asks the whole segment to be one
 * answer. An earlier version of this comment said 600 seconds "exceeds the
 * segment's own default budget of 10 minutes", which is the same number stated
 * as if it were a larger one, and reached for `applyFlex` to finish the
 * argument — but `applyFlex` clamps the segment to 5–25 minutes, so a 10-minute
 * answer is well inside what the segment can grow to. That is the argument, and it is the only one: this ceiling
 * does NOT catch unit typos. An earlier version of this comment claimed it
 * caught "a club meaning 2:30 and typing 230 seconds", which is false — 230 is
 * under 600 and stores a 3:50 cap happily. Unit mistakes are caught at the
 * PARSER (`MIN_BARE_SECONDS`) and only at the low end; a plausible-but-wrong
 * value in between is not machine-detectable and is the admin's to check.
 */
export const MAX_TABLE_TOPICS_SECONDS = 600;

/** A club's stated limits. Null means "not stated" — never zero, which is a
 *  real (if silly) limit and must not be confused with absence. */
export interface TableTopicsLimits {
	minSeconds: number | null;
	maxSeconds: number | null;
}

/**
 * Whether a club has stated a usable window.
 *
 * BOTH bounds or neither. A half-stated window cannot produce timer marks —
 * green and red are both required, and inventing the missing one from the
 * default would silently mix a club's number with ours and print a window the
 * club never agreed to. A club that has filled in only one field is treated as
 * having stated nothing, which is the same thing every surface already handles.
 *
 * The ordering check is here rather than only in the form, because this module
 * is what the renderers trust: a max below the min would put red before green
 * on the Timer's card, which is worse than showing the default.
 */
export function hasTableTopicsLimits(
	limits: TableTopicsLimits | null | undefined,
): limits is { minSeconds: number; maxSeconds: number } {
	if (!limits) return false;
	const { minSeconds, maxSeconds } = limits;
	if (minSeconds == null || maxSeconds == null) return false;
	// INTEGER, not merely finite. The zod schema carries `.int()` on the write
	// path with the note that a fractional second is where "2:30" becomes "2:29"
	// on one surface and "2:30" on another — and this guard exists precisely for
	// rows the write path never saw. Without it, 60.5/150.4 renders as
	// "1:01 … 2:30" on the deck (formatted, rounded) while the Timer's card gets
	// 1.0083/2.5067 unrounded: the two surfaces disagreeing by the very
	// mechanism the `.int()` comment describes. `isInteger` is false for NaN and
	// both Infinities, so it subsumes the finiteness check it replaces.
	if (!Number.isInteger(minSeconds) || !Number.isInteger(maxSeconds))
		return false;
	// Only the LOW bound is checked here. `maxSeconds <= 0` stood beside it and
	// was unreachable by construction — past this line `minSeconds >= 0`, and the
	// final `maxSeconds > minSeconds` already rejects every value it could have
	// caught. No test could tell its presence from its absence, which is a
	// mutation-survivor dressed as a guard.
	if (minSeconds < 0) return false;
	// The ceiling is enforced HERE as well as at the write, because this module
	// is what the renderers trust and a row predating the cap (or written by a
	// script) must not reach the Timer's card.
	if (maxSeconds > MAX_TABLE_TOPICS_SECONDS) return false;
	return maxSeconds > minSeconds;
}

/**
 * The green/yellow/red timer marks for this club's Table Topics, in MINUTES.
 *
 * Yellow is the MIDPOINT, and that is not a choice made here — it is the rule
 * `timing-window.ts` states for every timed beat in the app ("green = min,
 * yellow = midpoint, red = max"), and both existing constants obey it
 * (Table Topics 1 / 1.5 / 2, evaluation 2 / 2.5 / 3). Deriving it keeps a club's
 * three lights consistent with every other beat's rather than making Table
 * Topics the one segment whose middle light means something different.
 *
 * The midpoint is rounded to a WHOLE SECOND before it becomes minutes, and that
 * is a correctness fix rather than tidiness. `mark_yellow` is `real()` — float4
 * — so a materialised template stores this value at ~7 significant digits while
 * every unmaterialised surface re-derives it as a float64. When the two bounds
 * sum to an odd number of seconds the midpoint lands on a half second, and
 * `formatTimingClock`'s `Math.round` then breaks the tie from the wrong side of
 * the float4 noise: a 1:00–2:35 club gets 1:48 live and 1:47 off the frozen row,
 * one meeting's Timer signalling a second earlier than the next for no reason
 * anyone can see. Rounding first makes yellow a multiple of 1/60, where float4
 * error is ~1e-5 seconds and can never flip the tie. 25.6% of the windows a club
 * can state are odd-summed, so this is not an edge case.
 */
export function resolveTableTopicsMarks(
	limits: TableTopicsLimits | null | undefined,
): TimingMarks {
	if (!hasTableTopicsLimits(limits)) return TABLE_TOPICS_MARKS;
	const yellowSeconds = Math.round((limits.minSeconds + limits.maxSeconds) / 2);
	return {
		green: limits.minSeconds / 60,
		yellow: yellowSeconds / 60,
		red: limits.maxSeconds / 60,
	};
}

/**
 * The deck's "Speaker time:" line.
 *
 * The ONLY caller is `agenda-slides.ts`. An earlier version of this line also
 * claimed "the run sheet's timing clause", and the run sheet has never called
 * it: the printed sheet and the on-screen agenda reach the same two numbers
 * through `resolveTableTopicsMarks` → `beat.marks`, a different derivation with
 * a different output shape. Both paths must move together; only one of them
 * comes through here.
 *
 * Stated the way a club states it on its own printed agenda: the floor, the
 * cap, and the first disqualifying second. The DQ point is DERIVED as one
 * second past the cap rather than stored, so it cannot drift from the cap an
 * admin edits — MCF's own sheet says "2.3 min max, 2.31+ disqualified", which
 * is the same fact twice.
 *
 * Note this is deliberately NOT the 30-second qualifying grace of
 * `timing-window.ts`. That rule is about prepared SPEECHES: a club's Table
 * Topics cap is its own rule and is stated as its own rule.
 *
 * `firstQualifyingWindow` enforces that by skipping every non-speaker row
 * (#357) — but it is one of TWO derivations, and an earlier version of this
 * paragraph cited it as if it covered both. `beatTimingText` (the TEMPLATED
 * deck) calls `qualifyingWindowForMarks` directly with no filter at all, so a
 * materialised meeting projected "qualifies 0:30–3:00" beside a
 * non-materialised one saying "2:31+ disqualified" — two disqualification rules
 * for one club, differing only by whether anyone had opened the agenda editor.
 * `TABLE_TOPICS_ROLE_KEY` and `formatTableTopicsWindow` below are what that
 * derivation now uses instead.
 */
export function formatTableTopicsTiming(
	limits: TableTopicsLimits | null | undefined,
): string {
	if (!hasTableTopicsLimits(limits)) return TABLE_TOPICS_DEFAULT_TIMING;
	const min = formatSeconds(limits.minSeconds);
	const max = formatSeconds(limits.maxSeconds);
	const dq = formatSeconds(limits.maxSeconds + 1);
	return `${min} minimum · ${max} maximum · ${dq}+ disqualified`;
}

/**
 * The three refusals, stated once.
 *
 * The admin form checks these before the request so a typo lands on the field
 * that is wrong, and the zod schema checks them again because a server fn is
 * addressable without the form. That is two enforcement points by design — but
 * it was also two byte-for-byte copies of each sentence, with nothing linking
 * them, so editing one left the same rule speaking with two voices depending on
 * which layer rejected the write. `CLUB_ARCHIVED_MESSAGE` in `#/lib/club-archive`
 * is the existing pattern for exactly this shape.
 */
export const TABLE_TOPICS_MESSAGES = {
	unparseable: "Enter Table Topics limits as minutes and seconds, like 2:30.",
	halfStated: "Set both the minimum and the maximum, or neither.",
	inverted: "The maximum must be longer than the minimum.",
	/** The ceiling, said in the admin's units rather than in seconds. */
	tooLong: `Table Topics limits cannot be longer than ${
		MAX_TABLE_TOPICS_SECONDS / 60
	}:00.`,
} as const;

/**
 * The `role_definitions.key` of the beat this window governs.
 *
 * Named rather than typed inline because two derivations have to agree about
 * WHICH row is the Table Topics segment — `beatTimingText` on the templated
 * deck, and the Timer's role sheet — and a hand-typed `"table_topics_master"`
 * in either of them is a rename away from silently governing nothing.
 */
export const TABLE_TOPICS_ROLE_KEY = "table_topics_master";

/**
 * The club's window as a plain span, e.g. "1:00–2:30".
 *
 * The same two numbers `formatTableTopicsTiming` states as a sentence, in the
 * shape a `QualifyingWindow.range` uses, so the templated deck can print the
 * club's rule in the slot where it used to print the speech grace. Taking
 * MARKS rather than the stored seconds is deliberate: a templated row renders
 * the marks FROZEN into it, and re-deriving from the club's current columns
 * there would make the wall disagree with the paper the room is holding.
 */
export function formatTableTopicsWindow(marks: TimingMarks): string {
	return `${formatSeconds(marks.green * 60)}–${formatSeconds(marks.red * 60)}`;
}

/**
 * "2:30" → 150, and null for anything that is not a clock.
 *
 * The admin form's input format, because a club states this rule as a clock and
 * typing "150" to mean two and a half minutes is a form nobody gets right.
 *
 * Two shapes are refused, and both refusals exist because accepting them stores
 * a WRONG number silently rather than failing:
 *
 * · A DECIMAL. MCF's own sheet writes the cap "2.3 min" meaning 2:30, so
 *   reading it as 2.3 minutes would store 2:18 — the exact rounding this column
 *   is in seconds to avoid.
 * · A bare number BELOW `MIN_BARE_SECONDS`. Bare digits are read as seconds,
 *   which an earlier version of this comment called "unambiguous". It is not:
 *   an admin thinking in MINUTES types 1 and 2, every downstream check passes
 *   (both set, max > min, integer, under the ceiling), and the Timer's card
 *   prints green 0:01 and red 0:02 while the deck projects "0:01 minimum".
 *   No speaking limit any club runs is under 20 seconds, so a bare value below
 *   that is a unit mistake, not a rule. `0:02` in clock form is still accepted:
 *   the clock is explicit about its units, so someone who writes it means it.
 */
export const MIN_BARE_SECONDS = 20;

export function parseTableTopicsClock(raw: string): number | null {
	const text = raw.trim();
	if (text === "") return null;
	const clock = /^(\d{1,3}):([0-5]\d)$/.exec(text);
	if (clock) {
		return Number(clock[1]) * 60 + Number(clock[2]);
	}
	if (!/^\d{1,4}$/.test(text)) return null;
	const seconds = Number(text);
	return seconds < MIN_BARE_SECONDS ? null : seconds;
}

/** Whole seconds → "2:30". Exported for the admin form, which round-trips the
 *  stored value back into its input. */
export function formatTableTopicsClock(totalSeconds: number): string {
	return formatSeconds(totalSeconds);
}

/** Whole seconds → "2:30". Local rather than `formatTimingClock`, which takes
 *  MINUTES and would need a divide-then-multiply round trip to get back to the
 *  exact second a club typed. */
function formatSeconds(totalSeconds: number): string {
	const safe = Math.max(0, Math.round(totalSeconds));
	const mins = Math.floor(safe / 60);
	return `${mins}:${String(safe % 60).padStart(2, "0")}`;
}

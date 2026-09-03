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
// The Timer's printed ROLE SHEET is deliberately NOT covered. It has a fourth
// hardcoded copy — `STANDARD_TIMING_WINDOWS` in `server/role-sheet-layout.ts`,
// feeding both the printed window table and the sentence the Timer reads aloud
// — and it takes no club agenda config at all, because those sheets are
// club-agnostic artifacts built by `scripts/build-role-sheets.ts` and committed
// as PDFs. Wiring it is a real change with its own shape, filed separately. Say
// so here rather than letting this header imply the reconciliation is complete.
//
// `agenda-runsheet.ts`'s own comment named this upgrade before it existed —
// "If a club ever needs its own, the upgrade is a per-club override that falls
// back to these, which is why the numbers sit behind a name instead of inline
// in the beat table." This module is that override.
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
 * Ten minutes is already four times the longest Table Topics answer any club
 * runs, and it exceeds the segment's own default budget of 10 minutes — so a
 * cap above it asks `applyFlex` to fit a segment around a single answer longer
 * than the segment. That is the argument, and it is the only one: this ceiling
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
	if (minSeconds < 0 || maxSeconds <= 0) return false;
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
 */
export function resolveTableTopicsMarks(
	limits: TableTopicsLimits | null | undefined,
): TimingMarks {
	if (!hasTableTopicsLimits(limits)) return TABLE_TOPICS_MARKS;
	const green = limits.minSeconds / 60;
	const red = limits.maxSeconds / 60;
	return { green, yellow: (green + red) / 2, red };
}

/**
 * The deck's "Speaker time:" line, and the run sheet's timing clause.
 *
 * Stated the way a club states it on its own printed agenda: the floor, the
 * cap, and the first disqualifying second. The DQ point is DERIVED as one
 * second past the cap rather than stored, so it cannot drift from the cap an
 * admin edits — MCF's own sheet says "2.3 min max, 2.31+ disqualified", which
 * is the same fact twice.
 *
 * Note this is deliberately NOT the 30-second qualifying grace of
 * `timing-window.ts`. That rule is about prepared SPEECHES, and
 * `firstQualifyingWindow` skips every non-speaker row precisely so the Table
 * Topics window is never presented as a speech window (#357). A club's Table
 * Topics cap is its own rule and is stated as its own rule.
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

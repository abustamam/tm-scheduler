// src/lib/timing-window.ts
//
// The 30-second grace period and the qualifying window it implies (#357).
//
// The timing marks themselves are unchanged: green = min, amber = midpoint,
// red = max (`TimingMarks`, agenda-runsheet.ts). The grace period is a separate
// Toastmasters rule about QUALIFICATION, not about the signals — a speech
// qualifies from 30 s before green through 30 s after red. That window is what
// the Timer is actually watching for, so every surface that teaches the colors
// (both one-page agenda keys, the two-page "Timing Signals" callout, the Timer
// role sheet) states it here, from one source of truth, in concrete clock
// values derived from the slot's own min/max.
import type { TimingMarks } from "./agenda-runsheet";

/** The grace period either side of the assigned range, in minutes (30 s). */
export const TIMING_GRACE_MINUTES = 0.5;

/**
 * minutes (e.g. 6.5) → "6:30". Clamps at zero so a window whose lower end
 * crosses zero (a sub-grace minimum) never renders as a negative clock, and
 * carries a rounded-up 60 s into the next minute so nothing prints "5:60".
 */
export function formatTimingClock(minutes: number): string {
	const safe = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
	const whole = Math.floor(safe);
	const secs = Math.round((safe - whole) * 60);
	return secs === 60
		? `${whole + 1}:00`
		: `${whole}:${String(secs).padStart(2, "0")}`;
}

/** The span in which a speech still qualifies, plus display-ready clock text. */
export type QualifyingWindow = {
	/** Start of the window in minutes — never negative. */
	fromMinutes: number;
	/** End of the window in minutes. */
	toMinutes: number;
	/** `fromMinutes` as a clock, e.g. "4:30". */
	from: string;
	/** `toMinutes` as a clock, e.g. "7:30". */
	to: string;
	/** The window, e.g. "4:30–7:30". */
	range: string;
	/** The assigned min–max the window came from, e.g. "5:00–7:00". */
	assigned: string;
};

/**
 * The qualifying window for an assigned min–max, in minutes.
 *
 * `null` unless BOTH ends are known: a window has two edges, and a slot with
 * only a minimum (or only a maximum) has no window to state — which matches
 * `expandRunSheet`, where a half-specified slot gets no timing marks either.
 */
export function qualifyingWindow(
	minMinutes: number | null | undefined,
	maxMinutes: number | null | undefined,
): QualifyingWindow | null {
	if (minMinutes == null || maxMinutes == null) return null;
	if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes)) return null;
	if (maxMinutes < minMinutes) return null;
	const fromMinutes = Math.max(0, minMinutes - TIMING_GRACE_MINUTES);
	const toMinutes = maxMinutes + TIMING_GRACE_MINUTES;
	const from = formatTimingClock(fromMinutes);
	const to = formatTimingClock(toMinutes);
	return {
		fromMinutes,
		toMinutes,
		from,
		to,
		range: `${from}–${to}`,
		assigned: `${formatTimingClock(minMinutes)}–${formatTimingClock(maxMinutes)}`,
	};
}

/** The qualifying window behind a beat's green·amber·red marks (green = min,
 *  red = max), or `null` for an untimed beat. */
export function qualifyingWindowForMarks(
	marks: TimingMarks | null | undefined,
): QualifyingWindow | null {
	return qualifyingWindow(marks?.green, marks?.red);
}

/**
 * The window a printed agenda should teach: the first timed beat's. Only
 * speaker beats carry marks, so this is the first prepared speech — the
 * segment the grace rule matters most for, and a real number off this agenda
 * rather than a hardcoded example.
 */
export function firstQualifyingWindow(
	rows: readonly { marks: TimingMarks | null }[],
): QualifyingWindow | null {
	for (const row of rows) {
		const w = qualifyingWindowForMarks(row.marks);
		if (w) return w;
	}
	return null;
}

/** The compact one-line grace note for the one-page agenda keys, made concrete
 *  when the agenda has a timed beat and stating the bare rule when it doesn't. */
export function graceNote(w: QualifyingWindow | null): string {
	return w
		? `±0:30 grace — a ${w.assigned} speech qualifies ${w.range}`
		: "±0:30 grace — 0:30 before green through 0:30 after red";
}

/** The full-sentence form for the two-page "Timing Signals" callout and any
 *  other surface with room to spell the rule out. */
export function graceSentence(w: QualifyingWindow | null): string {
	const rule =
		"A speech qualifies from 0:30 before green through 0:30 after red";
	return w
		? `${rule} — a ${w.assigned} speech qualifies between ${w.from} and ${w.to}.`
		: `${rule}.`;
}

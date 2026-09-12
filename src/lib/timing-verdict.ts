/**
 * Did that speech count (#730).
 *
 * The SETTLED question, and deliberately not the live one. `timer-signal.ts`
 * (#729) answers "what colour is the card at this instant" off a running clock;
 * this answers "was that inside the qualifying window" off a stored
 * measurement, once, after the fact. Both read `timing-window.ts`; neither
 * imports the other, because they are different questions asked at different
 * times and a module that answered both would invite a caller to use the wrong
 * one.
 *
 * ## Derived, never stored
 *
 * `meeting_timings` stores the elapsed seconds and a COPY of the marks in force
 * when the clock stopped. It does not store a verdict, and it must not: a
 * verdict is the marks plus a RULE, and the rule is the club's — a stored
 * `qualified` would freeze today's rule into a row nobody can re-read. Storing
 * the marks and deriving the verdict stays true both ways: an officer editing
 * the agenda's min/max next month cannot re-decide a past speech (the marks are
 * on the row), and a change to the grace rule itself correctly re-reads every
 * historical row through the new one.
 *
 * `qualifyingWindow` is what supplies the rule, so the 30-second grace is
 * stated in exactly one place in this repo (`TIMING_GRACE_MINUTES`) and this
 * module never restates it.
 */
import { qualifyingWindow } from "./timing-window";

/**
 * `unknown` is a real answer and not an error case: a beat can carry a partial
 * or absent trio of marks, `meeting_timings` records that honestly as nulls,
 * and "we measured 6:11 against no stated window" is the truth about such a
 * row. Reporting `qualified` there would invent a window the club never set.
 */
export type TimingVerdict = "qualified" | "under" | "over" | "unknown";

/** The marks as `meeting_timings` stores them — minutes, each independently
 *  nullable, because that is what the column allows. */
export interface StoredTimingMarks {
	markGreen: number | null;
	markRed: number | null;
}

/**
 * The verdict for a stored measurement.
 *
 * `kind` is a ONE-MEMBER union today, which is the point rather than an
 * oversight: only prepared speeches and evaluations are recordable
 * (`timeable-roles.ts`), so only the speech rule applies — and requiring the
 * argument means a future Table Topics verdict has to add its own member and
 * its own rule rather than silently inheriting this one. That inheritance is
 * the two-walls failure `agenda-template-slides.ts` records.
 *
 * The window is INCLUSIVE at both ends: "a speech qualifies from 0:30 before
 * green THROUGH 0:30 after red" (#357), so exactly 4:30 and exactly 7:30 both
 * count, and `qualifyingWindow`'s own bounds are the ones being compared.
 */
export function timingVerdict(
	elapsedSeconds: number,
	marks: StoredTimingMarks,
	kind: "speech",
): TimingVerdict {
	void kind;
	// `qualifyingWindow` is null unless BOTH edges are set — `speechWindow`'s
	// rule, shared with the printed agenda — so a half-stated trio is unknown
	// here rather than half-judged.
	const window = qualifyingWindow(marks.markGreen, marks.markRed);
	if (!window) return "unknown";
	const minutes = elapsedSeconds / 60;
	if (minutes < window.fromMinutes) return "under";
	if (minutes > window.toMinutes) return "over";
	return "qualified";
}

/** What the verdict says on a printed record. Sentence case, because these land
 *  in the minutes PDF beside a name rather than as a badge. */
export const TIMING_VERDICT_LABEL: Record<TimingVerdict, string> =
	Object.freeze({
		qualified: "Qualified",
		under: "Under time",
		over: "Over time",
		unknown: "No window set",
	});

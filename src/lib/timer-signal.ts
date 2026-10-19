/**
 * Which card the Timer would be holding up right now (#729).
 *
 * The LIVE question, and deliberately not the settled one. `timing-verdict.ts`
 * (#730) answers "did that speech count", once, off a stored measurement;
 * this answers "what colour is the card at this instant" while the clock runs.
 * Both read `timing-window.ts`; neither imports the other, because they are
 * different rules and the shape of this file's mistake is a surface that
 * conflated them.
 *
 * ## Why `kind` is a parameter, and why `over` is not the red card
 *
 * Red means "your time is up". `over` means "you are past the point where this
 * speech still counts", and the two are separated by a rule that is DIFFERENT
 * for the two kinds of timed segment this app has marks for:
 *
 * - a prepared SPEECH qualifies through `red + TIMING_GRACE_MINUTES` — the
 *   30-second Toastmasters grace (#357), which `timing-window.ts` owns and
 *   which nothing here restates;
 * - a TABLE TOPICS answer follows the SAME rule since #1258: one rule, no club
 *   opt-out, every timed segment is disqualified strictly after red + 0:30.
 *   Red is the club's own cap; the grace is the same grace.
 *
 * What `kind` still decides is whether the segment HAS a window at all: a
 * Table Topics clock with no stated limits never reaches `over` (below).
 */
import type { TimingMarks } from "./agenda-runsheet";
import { TIMING_GRACE_MINUTES } from "./timing-window";

/**
 * `under` is before green; `green`/`yellow`/`red` are the three cards; `over`
 * is past the point where the segment still qualifies.
 *
 * Five bands rather than four because the Timer's job at `over` is different
 * from their job at `red`: red is a signal to the speaker, over is a fact about
 * the award.
 */
export type TimerBand = "under" | "green" | "yellow" | "red" | "over";

/** Which disqualification rule applies. A one-per-kind union rather than an
 *  optional flag, so a new timed segment shape has to choose a rule rather than
 *  silently inheriting the speech grace. */
export type TimerKind = "speech" | "tableTopics";

/** Minutes → ms, once, so no call site does the arithmetic. */
const MIN_MS = 60_000;

/**
 * The band for `elapsed` milliseconds against a row's marks.
 *
 * `marks` is `null` on an untimed row, and the answer is then `under` at every
 * instant: with no green there is no card to raise, and reporting anything else
 * would put a colour on a row the printed agenda leaves blank. The surface
 * simply does not render a clock for such a row (#729 shows only marked rows),
 * so this is the defensive answer rather than the displayed one.
 *
 * `limits` is required in spirit for `kind: "tableTopics"` and optional in the
 * type, because a club that has stated no window genuinely has no
 * disqualification point — `hasTableTopicsLimits` is what decides that, and a
 * caller holding `null` there must get "no DQ" rather than a guessed one. With
 * no limits a Table Topics clock therefore tops out at `red` and never reaches
 * `over`, which is the honest answer: the club has not said when an answer
 * stops counting.
 */
export function timerSignal(
	elapsed: number,
	marks: TimingMarks | null | undefined,
	kind: TimerKind,
	limits?: { maxSeconds: number } | null,
): TimerBand {
	if (!marks) return "under";
	// ONE rule (#1258): `over` begins strictly after red + the grace, the
	// instant `qualifyingWindow`'s inclusive bound still counts as qualifying.
	// `tableTopicsDqSeconds` is the same instant as a whole-second print ("2:31+").
	const pastGrace = elapsed > (marks.red + TIMING_GRACE_MINUTES) * MIN_MS;
	const over = kind === "speech" ? pastGrace : limits != null && pastGrace;
	// Checked FIRST so the DQ decision cannot be shadowed by the red band below.
	if (over) return "over";
	if (elapsed >= marks.red * MIN_MS) return "red";
	if (elapsed >= marks.yellow * MIN_MS) return "yellow";
	if (elapsed >= marks.green * MIN_MS) return "green";
	return "under";
}

/** What the band means in words — the same vocabulary the printed Timer role
 *  sheet and the agenda's timing key already teach, so the phone and the paper
 *  do not describe the same instant differently. */
export const TIMER_BAND_LABEL: Record<TimerBand, string> = Object.freeze({
	under: "Before green",
	green: "Green",
	yellow: "Yellow",
	red: "Red",
	over: "Over time",
});

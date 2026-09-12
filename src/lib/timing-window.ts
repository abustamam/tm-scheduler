// src/lib/timing-window.ts
//
// The 30-second grace period and the qualifying window it implies (#357).
//
// The timing marks themselves are unchanged: green = min, yellow = midpoint,
// red = max (`TimingMarks`, agenda-runsheet.ts). The grace period is a separate
// Toastmasters rule about QUALIFICATION, not about the signals — a speech
// qualifies from 30 s before green through 30 s after red. That window is what
// the Timer is actually watching for, so every surface that teaches the colors
// (both one-page agenda keys, the two-page "Timing Signals" callout, the Timer
// role sheet) states it here, from one source of truth, in concrete clock
// values derived from the slot's own min/max.
//
// The grace is SYMMETRIC for a prepared speech and for an evaluation, and it is
// NOT for Table Topics (#720). A Table Topics response has to REACH the minimum
// to be eligible for Best Table Topics — there is no thirty seconds of credit
// below green — so applying the speech rule there printed "qualifies 0:30–2:30"
// on the Timer's sheet, projected it on the templated deck, and put it in the
// Timer's spoken script: three surfaces stating one wrong eligibility rule,
// consistently, from this one function. Which segment a window describes is
// therefore an INPUT here (`TimingSegment`) rather than something each caller
// decides for itself, and the WORDING is derived from the same field as the
// numbers — see `graceNote`/`graceSentence` — so no surface can print "0:30
// before green" beside a window that starts at green.
import type { TimingMarks } from "./agenda-runsheet";
import { speechWindow } from "./speech-window";
// The role key only. `table-topics-limits` imports nothing from here at
// runtime and its only `agenda-runsheet` import is a type, so this closes no
// cycle — and naming the key rather than typing "table_topics_master" is what
// keeps `segmentFor` bound to the same constant the deck and the agenda editor
// match on.
import { TABLE_TOPICS_ROLE_KEY } from "./table-topics-limits";

/** The grace period either side of the assigned range, in minutes (30 s). */
export const TIMING_GRACE_MINUTES = 0.5;

/**
 * Which segment a qualifying window describes (#720).
 *
 * TWO members, not one per beat: the question this answers is only "does the
 * grace apply BELOW green", and an evaluation, an Ice Breaker and a prepared
 * speech all answer it the same way. `"speech"` is that answer and the default
 * everywhere, so every caller that says nothing keeps today's numbers exactly.
 *
 * `"tableTopics"` is the exception, and it is the club's own rule rather than
 * ours: `table-topics-limits.ts` already prints "2:31+ disqualified" from the
 * cap, and a floor of "green minus 0:30" contradicted that at the other end.
 * The UPPER grace is unchanged for both — a response is still eligible through
 * red + 0:30.
 */
export type TimingSegment = "speech" | "tableTopics";

/**
 * WHICH segment a row belongs to, from its `role_definitions.key` (#720).
 *
 * One derivation, because three surfaces need the answer and #720 is the bug
 * that three copies of one timing rule produces. Before this they each decided
 * for themselves and by different means — the Timer's sheet matched a display
 * label (`assignment === "Table Topics"`), the templated deck matched the role
 * key, and `firstQualifyingWindow` implied it from a speaker filter without
 * ever naming a segment. `agenda-template-slides.ts` records what the last
 * round of that cost: "two surfaces stating two disqualification rules for one
 * club, differing only by whether anyone had opened the agenda editor."
 *
 * `null`/absent is `"speech"`, matching `firstQualifyingWindow`'s existing rule
 * that a row with no `roleKey` is an event row and gets the speech treatment.
 * Every non-Table-Topics segment is `"speech"` by construction — there is no
 * third answer to give, because the only question is whether the grace applies
 * below green.
 */
export function segmentFor(roleKey: string | null | undefined): TimingSegment {
	return roleKey === TABLE_TOPICS_ROLE_KEY ? "tableTopics" : "speech";
}

/**
 * How far BELOW green the window reaches, per segment.
 *
 * A record rather than a boolean parameter so the rule is stated once, in one
 * place, for every segment there is: a reader asking "which segments get the
 * lower grace" gets a complete answer here instead of having to find every
 * `graceBelow: false` call site.
 */
const GRACE_BELOW_MINUTES: Record<TimingSegment, number> = {
	speech: TIMING_GRACE_MINUTES,
	tableTopics: 0,
};

/**
 * The BARE span each segment qualifies over — the clause with no subject.
 *
 * The one place a segment's rule is written in words. Everything else in this
 * file that says the rule is built from this: the full sentence below, the
 * compact note's fallback branch, and both concrete forms. Stated separately
 * from `SEGMENT_RULE` because the compact note prints the span WITHOUT a
 * subject ("±0:30 grace — 0:30 before green through 0:30 after red") and the
 * sentence prints it WITH one, and those two were a hardcoded literal each
 * until they disagreed — the module header claimed no surface could pair the
 * speech words with a Table Topics window while `graceNote`'s own null branch
 * derived from nothing at all.
 */
const SEGMENT_SPAN: Record<TimingSegment, string> = {
	speech: "0:30 before green through 0:30 after red",
	// "from green", not "from 0:30 before green" — the whole of #720 is that
	// there is no credit below the minimum here. Kept to one clause because the
	// Timer's sheet prints both segments' sentences plus its own trailing line
	// inside a one-page budget (`role-sheet-layout.test.ts` fails you if it
	// spills).
	tableTopics: "green through 0:30 after red",
};

/** What one timed item of this segment is CALLED, for the concrete "e.g. a
 *  5:00–7:00 speech qualifies …" half of the copy, and for the subject of the
 *  full sentence below. */
const SEGMENT_NOUN: Record<TimingSegment, string> = {
	speech: "speech",
	tableTopics: "Table Topics response",
};

/** The rule each segment's window obeys, as a clause. DERIVED from the noun and
 *  the span, so the numbers a surface prints and the sentence beside them come
 *  from one place and cannot disagree (#720). */
const SEGMENT_RULE: Record<TimingSegment, string> = {
	speech: `A ${SEGMENT_NOUN.speech} qualifies from ${SEGMENT_SPAN.speech}`,
	tableTopics: `A ${SEGMENT_NOUN.tableTopics} qualifies from ${SEGMENT_SPAN.tableTopics}`,
};

/** The compact grace label. `±` only where the grace really is symmetric. */
const SEGMENT_GRACE_LABEL: Record<TimingSegment, string> = {
	speech: "±0:30 grace",
	tableTopics: "+0:30 grace",
};

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
	/**
	 * The segment this window describes (#720) — what makes the COPY beside it
	 * derivable rather than hand-matched.
	 *
	 * Carried on the result, not just taken as an argument, because the two
	 * halves of a printed grace line are produced by different functions:
	 * `qualifyingWindow` computes the numbers and `graceNote`/`graceSentence`
	 * write the sentence. Before this they agreed only by every call site
	 * remembering to pair them, and a Table Topics window under the speech
	 * sentence is exactly the failure #720 reports.
	 */
	segment: TimingSegment;
};

/**
 * The qualifying window for an assigned min–max, in minutes.
 *
 * `null` unless the slot has a window at all — `speechWindow` (#394) is the one
 * rule for that, shared with the deck's "Time:" line, the run sheet's booked
 * duration and its timing marks. A half-specified slot is unconfigured, and a
 * window that isn't backed by two real edges is one nobody can time against.
 *
 * `segment` defaults to `"speech"`, which is what every caller but the Table
 * Topics ones wants and what all of them did before #720 — so a call that says
 * nothing is byte-identical to the old behaviour.
 */
export function qualifyingWindow(
	minMinutes: number | null | undefined,
	maxMinutes: number | null | undefined,
	segment: TimingSegment = "speech",
): QualifyingWindow | null {
	const w = speechWindow({ minMinutes, maxMinutes });
	if (!w) return null;
	const fromMinutes = Math.max(0, w.min - GRACE_BELOW_MINUTES[segment]);
	const toMinutes = w.max + TIMING_GRACE_MINUTES;
	const from = formatTimingClock(fromMinutes);
	const to = formatTimingClock(toMinutes);
	return {
		fromMinutes,
		toMinutes,
		from,
		to,
		range: `${from}–${to}`,
		assigned: `${formatTimingClock(w.min)}–${formatTimingClock(w.max)}`,
		segment,
	};
}

/** The qualifying window behind a beat's green·yellow·red marks (green = min,
 *  red = max), or `null` for an untimed beat. `segment` as above: pass
 *  `"tableTopics"` for the one segment with no grace below green (#720). */
export function qualifyingWindowForMarks(
	marks: TimingMarks | null | undefined,
	segment: TimingSegment = "speech",
): QualifyingWindow | null {
	return qualifyingWindow(marks?.green, marks?.red, segment);
}

/**
 * The window a printed agenda should teach: the first SPEECH's — the segment
 * the grace rule matters most for, and a real number off this agenda rather
 * than a hardcoded example.
 *
 * The speaker filter used to be implicit: only speaker beats carried marks, so
 * "first marked row" and "first speech" were the same row. #507 gave evaluations
 * and Table Topics marks too, and the implicit version then taught the wrong
 * window — a club whose speakers have no recorded min/max (the AgendaSlot
 * default) got "e.g. a 1:00–2:00 speech qualifies 0:30–2:30", which is the Table
 * Topics window presented as a speech. A Timer reading that would disqualify a
 * prepared speech that actually qualifies, which is the exact error #357 exists
 * to prevent. Rows without a `roleKey` are treated as speeches so the older
 * call shape keeps working (event rows have a null roleKey and no marks).
 */
export function firstQualifyingWindow(
	rows: readonly { marks: TimingMarks | null; roleKey?: string | null }[],
): QualifyingWindow | null {
	for (const row of rows) {
		if (row.roleKey != null && row.roleKey !== "speaker") continue;
		// The filter above already admits only speeches, so `segmentFor` can only
		// answer "speech" here — and that is the point of asking it rather than
		// letting the default do the work silently. The row's key decides its
		// segment in ONE place (#720); this surface additionally decides which
		// ROW to teach from, which is #507's separate rule.
		const w = qualifyingWindowForMarks(row.marks, segmentFor(row.roleKey));
		if (w) return w;
	}
	return null;
}

/** The compact one-line grace note for the one-page agenda keys, made concrete
 *  when the agenda has a timed beat and stating the bare rule when it doesn't. */
export function graceNote(w: QualifyingWindow | null): string {
	// "e.g." is load-bearing: the window comes from the FIRST timed beat, and an
	// agenda can mix assignments (an Ice Breaker at 4–6 ahead of two 5–7
	// speeches). Stated bare, a Timer reading the key would disqualify a 7:10
	// prepared speech that actually qualifies — the exact error #357 exists to
	// prevent. The "±0:30 grace" prefix is the rule; the numbers are one example
	// of it, and each speaker's own trio is inches away on the same sheet.
	//
	// The prefix and the noun both follow the window's own segment (#720), so
	// this cannot print "±0:30 grace" over a window that has no grace below
	// green. `firstQualifyingWindow` only ever hands this a SPEECH today, which
	// is why the printed keys are unchanged — but the pairing is now structural
	// rather than a property of that filter.
	//
	// The no-window branch is DERIVED too, from the speech segment rather than
	// from a literal. It was the one place in this file that spelled the rule out
	// by hand, which made the module header's "no surface can print '0:30 before
	// green' beside a window that starts at green" an overclaim about its own
	// neighbour: editing `SEGMENT_SPAN.speech` would have moved every other
	// surface and left this line behind.
	const segment = w?.segment ?? "speech";
	if (!w) return `${SEGMENT_GRACE_LABEL[segment]} — ${SEGMENT_SPAN[segment]}`;
	return `${SEGMENT_GRACE_LABEL[segment]} — e.g. a ${w.assigned} ${
		SEGMENT_NOUN[segment]
	} qualifies ${w.range}`;
}

/**
 * The rule for ONE segment as a standalone sentence (#720).
 *
 * For a surface that states the rule beside a table holding BOTH kinds of row —
 * the Timer's sheet lists prepared speeches, evaluations and Table Topics in one
 * "Qualifies" column — so one sentence about speeches would contradict the cell
 * an inch away. Exported rather than inlined because the Timer READS IT ALOUD:
 * the spoken script and the printed cell have to be the same rule, and #443
 * already shipped once with only one of the two wired.
 */
export function graceRuleSentence(segment: TimingSegment): string {
	return `${SEGMENT_RULE[segment]}.`;
}

/** The full-sentence form for the two-page "Timing Signals" callout and any
 *  other surface with room to spell the rule out. The rule follows the window's
 *  own segment, exactly as `graceNote` above does (#720), and with no window it
 *  IS `graceRuleSentence("speech")` — delegated rather than restated, so the two
 *  cannot drift into being two sentences. */
export function graceSentence(w: QualifyingWindow | null): string {
	if (!w) return graceRuleSentence("speech");
	return `${SEGMENT_RULE[w.segment]} — a ${w.assigned} ${
		SEGMENT_NOUN[w.segment]
	} qualifies between ${w.from} and ${w.to}.`;
}

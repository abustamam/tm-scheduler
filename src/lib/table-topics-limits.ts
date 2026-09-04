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
 *
 * **LOWERING this number is a data migration, not a constant edit.** Since #679
 * `schema.ts` interpolates it into the `clubs_table_topics_window_check`
 * predicate, so `db:generate` answers a change here with `DROP CONSTRAINT` +
 * `ADD CONSTRAINT` at the new bound. Raising it is free. Lowering it fails the
 * new constraint's table scan on any club already storing a larger cap — and
 * that scan runs in the container's start command, so the deploy does not ship
 * a stale page, the server does not boot. CI cannot see it: the check job
 * applies migrations to a FRESH database with no club rows. A lowering change
 * needs a clamping `UPDATE clubs SET table_topics_max_seconds = <new ceiling>
 * WHERE table_topics_max_seconds > <new ceiling>` hand-added to the generated
 * migration ABOVE the `ADD CONSTRAINT`.
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
 * The FOUR refusal sentences, stated once.
 *
 * Module-internal in practice since #679: `refuseTableTopicsSeconds` and
 * `validateTableTopicsForm` below are the only non-test readers, and the wiring
 * guard asserts the admin route no longer names this object at all. That is the
 * end state of a two-step collapse worth recording, because the first step
 * looked like the whole fix and was not. #443 shared the SENTENCES — they had
 * been byte-for-byte copies in the form and in the zod schema, so editing one
 * left the rule speaking with two voices, the shape `CLUB_ARCHIVED_MESSAGE`
 * exists to prevent. #679 found that sharing the words had not stopped the two
 * layers disagreeing about the RULES: the form was missing the ceiling check its
 * own comment promised. Sharing the predicate is what closed it; the sentences
 * now travel with the rule that selects them.
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
 * Named rather than typed inline because several derivations have to agree
 * about WHICH row is the Table Topics segment, and a hand-typed
 * `"table_topics_master"` in any of them is a rename away from silently
 * governing nothing. The readers are `beatTimingText` on the templated deck and
 * `isTableTopicsSegment` (`agenda-template-rows.ts`), which the agenda editor
 * also calls — one predicate, two call sites, after #679 found that the editor
 * had grown its own copy.
 *
 * The Timer's role sheet is NOT one of them, and an earlier version of this
 * paragraph said it was. `role-sheet-layout.ts` matches its own
 * `TABLE_TOPICS_ASSIGNMENT = "Table Topics"` against the printed table's
 * assignment column — a different coupling, to a display label rather than to a
 * role key, and worth knowing about separately when either string moves.
 */
export const TABLE_TOPICS_ROLE_KEY = "table_topics_master";

/**
 * The club's window as a plain span, e.g. "1:00–2:30".
 *
 * The same two numbers `formatTableTopicsTiming` states as a sentence, in the
 * shape a `QualifyingWindow.range` uses, so the templated deck can print the
 * club's rule in the slot where it used to print the speech grace.
 *
 * Takes MARKS rather than the stored seconds, and since #679 that is no longer
 * a compromise. The original reason was that a templated row rendered the marks
 * FROZEN into it, so re-deriving from the club's current columns here would
 * have made the wall disagree with the paper the room is holding — which
 * accepted a stale span to keep two surfaces consistent.
 * `refreshTableTopicsMarks` removed the staleness at its source, so on the
 * templated deck the marks this is handed are the club's current window and
 * both properties hold at once.
 *
 * Stated as "on the templated deck" rather than universally, because this is
 * also called with `resolveTableTopicsMarks(...)` output directly (the Timer's
 * role sheet), where the question does not arise.
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

/** Which input a refusal belongs to. The admin form marks that field
 *  `aria-invalid`; the zod schema turns it into the issue's `path`. */
export type TableTopicsField = "min" | "max";

/** A refusal: the sentence to show, and the field it is about. */
export type TableTopicsRefusal = {
	field: TableTopicsField;
	message: string;
};

/**
 * The three rules about the NUMBERS, stated ONCE.
 *
 * Two layers have to enforce these — the admin form, so a typo lands on the
 * field that is wrong rather than coming back as a server error on a form
 * already submitted; and `clubAgendaSettingsSchema`, because a server fn is
 * addressable with no form at all. #443 shipped them as two hand-written
 * copies, and the copies had already diverged before the ink dried: the form
 * was missing the ceiling check its own comment promised, so `20:00` passed
 * every client check and came back as a raw zod `.max(600)` message. Sharing
 * the SENTENCES (`TABLE_TOPICS_MESSAGES`) was the half #443 fixed; sharing the
 * RULES is this half, and it is the half that was actually wrong.
 *
 * The ORDER is load-bearing, and the reason is simpler than it looks: this
 * function returns on the FIRST match, so its order alone decides which sentence
 * an input that breaks several rules gets — and both layers read that one
 * answer. `("20:00", "30:00")` is "too long" on the minimum everywhere, where
 * the natural hand-written order ("both or neither" first) would have said
 * nothing about the ceiling at all.
 *
 * Do not restate that as "matches zod's shape-then-refinement phases". It did
 * when the ceiling was a per-bound `.max()`; #679 moved the ceiling in here, so
 * zod now has no per-bound rule to sequence against and the two layers agree
 * because they call this, not because the phases line up.
 *
 * NOT the same question as `hasTableTopicsLimits`, which is deliberately a
 * separate predicate one screen up: that one decides whether to TRUST a row
 * already stored — so it also refuses fractions and negatives, values no
 * writer here can produce but a script can — while this one decides whether to
 * STORE one, and gets to say WHY and about WHICH field. Collapsing them would
 * mean either the renderer growing user-facing sentences it never shows, or
 * this one losing the field attribution the form needs.
 */
export function refuseTableTopicsSeconds(
	minSeconds: number | null,
	maxSeconds: number | null,
): TableTopicsRefusal | null {
	if (minSeconds != null && minSeconds > MAX_TABLE_TOPICS_SECONDS)
		return { field: "min", message: TABLE_TOPICS_MESSAGES.tooLong };
	if (maxSeconds != null && maxSeconds > MAX_TABLE_TOPICS_SECONDS)
		return { field: "max", message: TABLE_TOPICS_MESSAGES.tooLong };
	if ((minSeconds == null) !== (maxSeconds == null))
		// The BLANK one is the field to fill, which is not the one carrying the
		// value: an admin who typed a maximum and left the minimum empty needs the
		// cursor in the minimum.
		return {
			field: minSeconds == null ? "min" : "max",
			message: TABLE_TOPICS_MESSAGES.halfStated,
		};
	if (minSeconds != null && maxSeconds != null && maxSeconds <= minSeconds)
		return { field: "max", message: TABLE_TOPICS_MESSAGES.inverted };
	return null;
}

/**
 * The refusal that should still be showing after the admin edits `field`.
 *
 * **Which refusals survive depends on their SCOPE, not just their field**, and
 * the first cut of this got that wrong in a way worth recording. It cleared
 * only when the flagged field itself was edited, which is right for the two
 * refusals that belong to ONE input — `unparseable` and `tooLong` — because
 * dismissing the red border on a still-unparseable Minimum when the admin types
 * in Maximum says the field is fixed when it is not.
 *
 * It is wrong for the other two, whose cause lives in the PAIR. `inverted` is
 * attributed to `max`, so an admin who resolves it by LOWERING the minimum was
 * left with "The maximum must be longer than the minimum." standing over a
 * valid pair. `halfStated` is attributed to the BLANK field, so an admin who
 * resolves it by clearing the OTHER one — the legitimate "we state no window"
 * outcome — was left with "Set both…" on a form that now correctly states
 * neither. In both cases `aria-describedby` kept pointing a screen reader at a
 * sentence that had stopped being true, which is worse than showing nothing.
 *
 * So a pair-scoped refusal clears on an edit to EITHER input. It is not
 * re-derived here: the caller holds the text, this holds only the rule, and
 * re-validating on every keystroke would flag a half-typed "2:" as unparseable
 * while the admin is still typing it.
 *
 * Lifted out of `club-settings.tsx` rather than written inline there, which is
 * the mistake #679 exists to correct — and the first cut of #679 re-made it, at
 * smaller scale, in the same file. A route file cannot be mounted in vitest, so
 * an inline `prev?.field === field ? null : prev` is one inverted operator away
 * from a form whose error marker clears on the wrong keystroke, with the whole
 * suite green. Two lines are not too few to be worth a test; they are exactly
 * the size that gets written without one — and the scope bug above is what a
 * test found the moment there was one.
 */
export function refusalAfterEdit(
	previous: TableTopicsRefusal | null,
	field: TableTopicsField,
): TableTopicsRefusal | null {
	if (!previous) return null;
	if (PAIR_SCOPED_MESSAGES.has(previous.message)) return null;
	return previous.field === field ? null : previous;
}

/**
 * The refusals an edit to EITHER field can resolve.
 *
 * Keyed on the MESSAGE because that is what a refusal carries — the alternative
 * was a third field on `TableTopicsRefusal` that every producer would have to
 * remember to set, and a producer that forgot would silently get the wrong
 * clearing behaviour. These two sentences come from `TABLE_TOPICS_MESSAGES`, so
 * the set cannot drift from them without failing to compile.
 */
const PAIR_SCOPED_MESSAGES: ReadonlySet<string> = new Set([
	TABLE_TOPICS_MESSAGES.halfStated,
	TABLE_TOPICS_MESSAGES.inverted,
]);

/** What the admin form got: the two columns to write, or the one refusal to
 *  show. Discriminated on `ok` so a caller cannot read `minSeconds` off a
 *  refusal or a `message` off a success. */
export type TableTopicsFormResult =
	| { ok: true; minSeconds: number | null; maxSeconds: number | null }
	| ({ ok: false } & TableTopicsRefusal);

/**
 * The admin form's whole validation, as a pure function of the two typed
 * strings.
 *
 * It lived inline in `club-settings.tsx` — a ROUTE file, which cannot be
 * mounted in vitest — so four branches and two initial-state expressions were
 * unreachable by any test, and the missing ceiling check sat there unnoticed
 * through a review that was looking for exactly that (#679). This is the same
 * move `#/lib/image-dimensions` made for the logo form and for the same reason:
 * the logic a client needs is not testable where the client happens to keep it.
 *
 * BLANK is not the same as unparseable, and the distinction is the whole
 * contract with the columns: blank means "we state no rule" and CLEARS both
 * columns to null, while `"abc"` or `"2.5"` is refused outright. Coercing
 * instead is how the wrong rule gets stored silently — `parseTableTopicsClock`
 * returns null for both cases, so the emptiness test has to come first and
 * cannot be folded into the parse.
 */
export function validateTableTopicsForm(
	minText: string,
	maxText: string,
): TableTopicsFormResult {
	const minBlank = minText.trim() === "";
	const maxBlank = maxText.trim() === "";
	const minSeconds = minBlank ? null : parseTableTopicsClock(minText);
	const maxSeconds = maxBlank ? null : parseTableTopicsClock(maxText);
	if (!minBlank && minSeconds == null)
		return {
			ok: false,
			field: "min",
			message: TABLE_TOPICS_MESSAGES.unparseable,
		};
	if (!maxBlank && maxSeconds == null)
		return {
			ok: false,
			field: "max",
			message: TABLE_TOPICS_MESSAGES.unparseable,
		};
	const refusal = refuseTableTopicsSeconds(minSeconds, maxSeconds);
	if (refusal) return { ok: false, ...refusal };
	return { ok: true, minSeconds, maxSeconds };
}

/**
 * One stored bound as the text its input starts with.
 *
 * The other half of the route logic #679 named as untestable: the expressions
 * seeding `useState`, where `null` must become the EMPTY string and not
 * `"0:00"` — `formatTableTopicsClock(0)` is a perfectly good clock, so a `?? 0`
 * anywhere on this path turns "this club states no rule" into "this club's
 * minimum is zero seconds" on the screen, and the next save stores a
 * half-window.
 *
 * Per FIELD rather than per form, because that is the shape of the rule. The
 * object-in/object-out version this replaces made the caller build a
 * `TableTopicsLimits` literal only to destructure the answer apart again, and
 * gave one branch two ways to be tested.
 */
export function tableTopicsClockText(seconds: number | null): string {
	return seconds == null ? "" : formatTableTopicsClock(seconds);
}

/** Whole seconds → "2:30". Local rather than `formatTimingClock`, which takes
 *  MINUTES and would need a divide-then-multiply round trip to get back to the
 *  exact second a club typed. */
function formatSeconds(totalSeconds: number): string {
	const safe = Math.max(0, Math.round(totalSeconds));
	const mins = Math.floor(safe / 60);
	return `${mins}:${String(safe % 60).padStart(2, "0")}`;
}

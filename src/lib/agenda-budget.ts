// src/lib/agenda-budget.ts
//
// The agenda editor's NUMBERS. Pure, and in `lib/` rather than in the component
// or a server-fn module for the reason CLAUDE.md records twice: a constant that
// lives behind an unmountable surface can have its bounds raised with the whole
// suite green (#519's corollary, which #522 then repeated inside the very change
// that cited it). Everything here is reachable from a unit test.
import type { TimelineRow } from "./agenda-timing";
import { timelineEnd } from "./agenda-timing";

/** One section band's own total. */
export type SectionSubtotal = { label: string; minutes: number };

export type AgendaBudget = {
	totalMinutes: number;
	slotMinutes: number;
	/**
	 * Signed; positive is over. NEVER deadbanded.
	 *
	 * `applyFlex` collapses anything within `FLEX_TOLERANCE_MINUTES` to a
	 * status of "exact", which is right for a BANNER — nobody wants nagging
	 * about two minutes on a ninety-minute meeting — and wrong for a READOUT,
	 * whose job is to state the number. MCF's contest is exactly 2 over, so a
	 * footer derived from `status` would have said nothing at all about the
	 * meeting this feature exists for. `applyFlex`'s own docblock draws the
	 * same line: "the computed duration is never deadbanded".
	 */
	deltaMinutes: number;
	endsAt: string;
	sections: SectionSubtotal[];
};

/** A timed row plus where it came from — `SourcedAgendaRow` after timing. */
export type BudgetEntry = {
	row: TimelineRow;
	beatId: string;
	iteration: number;
	iterationCount: number;
};

/**
 * What the table renders: either a standalone row, or one iteration of a
 * repeat block.
 *
 * Banding is by ITERATION, never by beat, because the beats INTERLEAVE. The
 * expander emits a whole block per iteration, so a two-beat block over four
 * contestants comes out speech, silence, speech, silence… and the speech beat
 * owns positions 0, 2, 4, 6. There is no contiguous run of one beat's rows to
 * draw a band around; the iteration is the only contiguous unit.
 */
export type EditorBand =
	| { kind: "row"; entry: BudgetEntry }
	| {
			kind: "iteration";
			iteration: number;
			iterationCount: number;
			entries: BudgetEntry[];
			/** Only iteration 0 is editable; its cells write the shared beats. */
			editable: boolean;
			startsAt: string;
			/**
			 * The last row's START, NOT when the band ends.
			 *
			 * Named for what it holds. A band's true end is that row's start plus
			 * its own minutes, and this module cannot compute it: the times are
			 * pre-formatted "6:53" strings, so adding minutes would mean parsing a
			 * clock back out. The caller has the full timeline and derives the real
			 * end from the row AFTER the band — see `AgendaEditor`.
			 */
			lastRowStartsAt: string;
			minutes: number;
	  };

export function summarizeAgenda(
	entries: BudgetEntry[],
	slotMinutes: number,
	startsAt: Date | string,
	timeZone: string,
): AgendaBudget {
	const rows = entries.map((e) => e.row);
	const totalMinutes = rows.reduce((sum, r) => sum + r.minutes, 0);

	const sections: SectionSubtotal[] = [];
	for (const r of rows) {
		if (r.section === true) {
			sections.push({ label: r.who, minutes: 0 });
			continue;
		}
		// Rows before the first band belong to no section, deliberately: an agenda
		// may legally open without one, and inventing an "(untitled)" band would
		// put a heading on the printed page's behalf that nothing stored asked
		// for. Their minutes still count toward the total.
		const current = sections.at(-1);
		if (current) current.minutes += r.minutes;
	}

	return {
		totalMinutes,
		slotMinutes,
		deltaMinutes: totalMinutes - slotMinutes,
		endsAt: timelineEnd(rows, startsAt, timeZone),
		sections,
	};
}

/**
 * What the table actually renders, after the repeat tail is folded.
 *
 * `groupIntoBands` returns one band per iteration, which is the accurate
 * decomposition. For DISPLAY, iterations 2..N of one block collapse into a
 * single summary line: on a four-contestant contest that is six near-identical
 * rows saying nothing the first two do not, and it pushes the closing section
 * below the fold.
 *
 * The fold carries the clock SPAN, so nothing about timing is lost — you can
 * still see that contestant 4 starts at 7:34 without eight rows on screen.
 */
export type DisplayBand =
	| { kind: "row"; entry: BudgetEntry }
	| { kind: "iteration"; band: Extract<EditorBand, { kind: "iteration" }> }
	| {
			kind: "repeatTail";
			bands: Extract<EditorBand, { kind: "iteration" }>[];
			/** 2 — the first folded iteration, 1-based for display. */
			fromIteration: number;
			/** N — the last, 1-based. */
			toIteration: number;
			startsAt: string;
			/** The last row's START — see `EditorBand.lastRowStartsAt`. */
			lastRowStartsAt: string;
			minutes: number;
	  };

/**
 * Fold each block's non-editable iterations into one summary band.
 *
 * Only a RUN of consecutive non-editable iteration bands sharing an
 * `iterationCount` folds together — two different repeat blocks sitting
 * adjacent must not merge, for the same reason `groupIntoBands` compares the
 * count rather than the index alone.
 */
export function foldRepeatTail(bands: EditorBand[]): DisplayBand[] {
	const out: DisplayBand[] = [];
	let i = 0;
	while (i < bands.length) {
		const band = bands[i];
		if (!band) break;
		if (band.kind === "row") {
			out.push({ kind: "row", entry: band.entry });
			i += 1;
			continue;
		}
		if (band.editable) {
			out.push({ kind: "iteration", band });
			i += 1;
			continue;
		}
		const run: Extract<EditorBand, { kind: "iteration" }>[] = [];
		const { iterationCount } = band;
		while (i < bands.length) {
			const next = bands[i];
			if (
				!next ||
				next.kind !== "iteration" ||
				next.editable ||
				next.iterationCount !== iterationCount
			) {
				break;
			}
			run.push(next);
			i += 1;
		}
		const first = run[0];
		const last = run.at(-1);
		if (!first || !last) {
			// UNREACHABLE today: the head band satisfies the negation of every
			// condition the inner loop breaks on, so `run` always holds at least
			// it. Written as forward PROGRESS rather than a bare `continue`,
			// which would re-read the same index forever — and a hung tab is a
			// worse failure than an uncollapsed band. If a future change to the
			// break conditions can reject the head, this degrades to rendering
			// the band expanded instead of spinning.
			out.push({ kind: "iteration", band });
			i += 1;
			continue;
		}
		out.push({
			kind: "repeatTail",
			bands: run,
			fromIteration: first.iteration + 1,
			toIteration: last.iteration + 1,
			startsAt: first.startsAt,
			lastRowStartsAt: last.lastRowStartsAt,
			minutes: run.reduce((sum, b) => sum + b.minutes, 0),
		});
	}
	return out;
}

export function groupIntoBands(entries: BudgetEntry[]): EditorBand[] {
	const out: EditorBand[] = [];
	let i = 0;
	while (i < entries.length) {
		const head = entries[i];
		if (!head) break;
		if (head.iterationCount <= 1) {
			out.push({ kind: "row", entry: head });
			i += 1;
			continue;
		}
		// Consecutive entries sharing this iteration index form one band. The
		// expander emits a whole block per iteration before moving on, so this run
		// is exactly one iteration of it. `iterationCount` is compared too: two
		// DIFFERENT blocks sitting adjacent are both at iteration 0, and matching
		// on the index alone would fuse them into one band.
		const group: BudgetEntry[] = [];
		const { iteration, iterationCount } = head;
		while (i < entries.length) {
			const next = entries[i];
			if (
				!next ||
				next.iterationCount <= 1 ||
				next.iteration !== iteration ||
				next.iterationCount !== iterationCount
			) {
				break;
			}
			group.push(next);
			i += 1;
		}
		if (group.length === 0) {
			// Same forward-progress guarantee as `foldRepeatTail`, and unreachable
			// for the same reason: the head entry satisfies the negation of every
			// break condition above. Without it an empty run would leave `i`
			// unchanged and spin.
			out.push({ kind: "row", entry: head });
			i += 1;
			continue;
		}
		out.push({
			kind: "iteration",
			iteration,
			iterationCount,
			entries: group,
			editable: iteration === 0,
			startsAt: group[0]?.row.time ?? "",
			lastRowStartsAt: group.at(-1)?.row.time ?? "",
			minutes: group.reduce((sum, e) => sum + e.row.minutes, 0),
		});
	}
	return out;
}

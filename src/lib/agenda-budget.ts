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
			endsAt: string;
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
		out.push({
			kind: "iteration",
			iteration,
			iterationCount,
			entries: group,
			editable: iteration === 0,
			startsAt: group[0]?.row.time ?? "",
			endsAt: group.at(-1)?.row.time ?? "",
			minutes: group.reduce((sum, e) => sum + e.row.minutes, 0),
		});
	}
	return out;
}

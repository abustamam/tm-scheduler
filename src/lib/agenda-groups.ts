// src/lib/agenda-groups.ts
import type { TimelineRow } from "./agenda-timing";

/**
 * A run of ADJACENT run-of-show rows the same person presents back to back.
 *
 * This is a PRESENTATION concern and nothing else. The beats stay split at the
 * source: the President's close is three beats (#442/#352) because each carries
 * its own minutes on the running clock and its own slide in the projected deck,
 * and `agenda-parity.test.ts` compares that beat sequence against the deck's.
 * Merging there would move the meeting; merging here only stops the narrative
 * print layouts from printing "President" three times down one page.
 *
 * Every row lands in a group — a row with nobody adjacent to merge with becomes
 * a group of one — so the renderer has a single shape to map over rather than a
 * union it has to narrow at every use.
 */
export type AgendaGroup = {
	/** The presenter every row in the group shares (already the display string). */
	who: string;
	/** The `role_definitions.key` every row in the group shares — see `sameRun`. */
	roleKey?: string | null;
	/** At least one row, in meeting order. */
	rows: TimelineRow[];
};

/**
 * Whether `row` continues the run `prev` belongs to.
 *
 * Two guards beyond the obvious name match:
 *
 * - A hand-off row NEVER joins a run, in either direction. It renders as a
 *   `HandoffBand` — no clock stamp, its own italic treatment — and it is a real
 *   event between two beats, so absorbing it would both lose the band and claim
 *   the presenter ran straight through an introduction they were making.
 * - `roleKey` must match as well as `who`. The print layouts colour a row's
 *   spine and pick the speaker highlight FROM the key (`beatColor` /
 *   `isHighlighted`, #445), so a group has to be homogeneous in it or one spine
 *   would stand for two different roles. `who` alone cannot guarantee that: it
 *   is club-renameable free text since #445, so two roles renamed to the same
 *   string would collide. Absent and null are the same key — event beats omit
 *   the field entirely while a row built field-by-field may set null, and
 *   splitting the President's close over that distinction would be nonsense.
 */
function sameRun(prev: TimelineRow, row: TimelineRow): boolean {
	if (prev.handoff || row.handoff) return false;
	return (
		prev.who === row.who && (prev.roleKey ?? null) === (row.roleKey ?? null)
	);
}

/** Fold `rows` into runs of adjacent same-presenter rows, order preserved. */
export function groupByPresenter(rows: TimelineRow[]): AgendaGroup[] {
	const groups: AgendaGroup[] = [];
	for (const row of rows) {
		const open = groups.at(-1);
		// `open.rows.at(-1)` — the run continues from its LAST row, not its first,
		// which is the same thing today but stops being so the moment a future
		// guard depends on adjacency.
		const prev = open?.rows.at(-1);
		if (open && prev && sameRun(prev, row)) {
			open.rows.push(row);
			continue;
		}
		groups.push({ who: row.who, roleKey: row.roleKey, rows: [row] });
	}
	return groups;
}

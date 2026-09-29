/**
 * A meeting's run sheet per STORED row, with its clock and the booked slot
 * beside it (#966) — what the connector's `get_agenda` returns and what
 * `edit_agenda` plans against.
 *
 * Pure and in `lib/`, not beside the loaders in `meeting-agenda-edit-logic.ts`:
 * that module imports `#/db`, and a pure helper there is one the client cannot
 * reach, so the next surface that needs the same numbers would grow a second
 * way to get them (CODING_STANDARDS.md, "A THIRD motive").
 *
 * It runs the pipeline the print route and the agenda editor run —
 * `refreshTableTopicsMarks` → `buildTemplateRowsWithSource` → `applyFlex` →
 * `buildTimeline` — as another caller, never a second derivation. The refresh
 * is idempotent, so rows that arrive already refreshed are unchanged by it.
 */
import {
	type AgendaSlot,
	applyFlex,
	TABLE_TOPICS_MAX,
	TABLE_TOPICS_MIN,
} from "./agenda-runsheet";
import {
	buildTemplateRowsWithSource,
	refreshTableTopicsMarks,
	type TemplateBeatRow,
	type TemplateRoleRow,
} from "./agenda-template-rows";
import { buildTimeline, timelineEnd } from "./agenda-timing";
import type { TableTopicsLimits } from "./table-topics-limits";

/** One STORED agenda row as the connector reads it. */
export type AgendaRunSheetRow = {
	/** The row's id — what `edit_agenda` names it by. `std:<n>` when the
	 *  meeting has no stored agenda yet (see `AgendaRunSheet.idSource`). */
	rowId: string;
	kind: TemplateBeatRow["kind"];
	label: string;
	/** The row's note, as stored. */
	detail: string | null;
	/** The minutes stored on the row. On a flex row the clock ignores this. */
	minutes: number;
	/**
	 * When the row starts on the printed agenda ("12:15", 12-hour, the print
	 * route's own format), or null when it prints nothing — a repeat row whose
	 * role has no slots on this meeting.
	 */
	start: string | null;
	/** What the clock actually gives it: after flex, and summed over every
	 *  iteration of a repeat block. */
	scheduledMinutes: number;
	/** The range the flex segment stretches within, or null for a fixed row.
	 *  The bound is on the SEGMENT, not on each flex row (see `applyFlex`). */
	flex: { minMinutes: number; maxMinutes: number } | null;
	/** Set on a row that repeats once per slot of a role (the speeches). */
	repeats: { roleKey: string; times: number } | null;
};

/** A meeting's run sheet with its clock and the booked slot beside it. */
export type AgendaRunSheet = {
	/**
	 * `stored`: the ids are the meeting's own rows. `derived`: the meeting has
	 * never been edited, so these are the standard agenda's rows computed in
	 * memory with position ids (`std:<n>`); nothing was written to read them,
	 * and the first `edit_agenda` apply stores them.
	 */
	idSource: "stored" | "derived";
	/** The meeting's start, club-local, in the same 12-hour format as `start`. */
	startsAt: string;
	/** When the last row ends. */
	endsAt: string;
	/** The booked meeting length, and when that booking ends. */
	slotMinutes: number;
	slotEndsAt: string;
	totalMinutes: number;
	/** Signed and never deadbanded: positive is over the slot, negative under. */
	overByMinutes: number;
	rows: AgendaRunSheetRow[];
};

export type AgendaRunSheetInput = {
	idSource: AgendaRunSheet["idSource"];
	rows: TemplateBeatRow[];
	roles: TemplateRoleRow[];
	slots: AgendaSlot[];
	/** ISO instant. */
	scheduledAt: string;
	timeZone: string;
	lengthMinutes: number;
	tableTopicsLimits: TableTopicsLimits | null;
};

/**
 * Clock `rows` (default: the input's own). A parameter so a PLAN can clock
 * rows that are not stored yet with the pipeline that will clock them once
 * they are.
 */
export function agendaRunSheet(
	input: AgendaRunSheetInput,
	rows: TemplateBeatRow[] = input.rows,
): AgendaRunSheet {
	const ordered = [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
	const sourced = buildTemplateRowsWithSource(
		refreshTableTopicsMarks(ordered, input.tableTopicsLimits),
		input.roles,
		input.slots,
	);
	const flexed = applyFlex(
		sourced.map((e) => e.row),
		input.lengthMinutes,
	);
	const timed = buildTimeline(flexed.rows, input.scheduledAt, input.timeZone);

	const byBeat = new Map<
		string,
		{ start: string; minutes: number; iterations: number }
	>();
	timed.forEach((row, i) => {
		const beatId = sourced[i]?.beatId;
		if (beatId === undefined) return;
		const seen = byBeat.get(beatId);
		if (seen) {
			seen.minutes += row.minutes;
		} else {
			byBeat.set(beatId, {
				start: row.time,
				minutes: row.minutes,
				iterations: sourced[i]?.iterationCount ?? 1,
			});
		}
	});

	return {
		idSource: input.idSource,
		startsAt: timelineEnd([], input.scheduledAt, input.timeZone),
		endsAt: timelineEnd(flexed.rows, input.scheduledAt, input.timeZone),
		slotMinutes: input.lengthMinutes,
		slotEndsAt: timelineEnd(
			[{ minutes: input.lengthMinutes }],
			input.scheduledAt,
			input.timeZone,
		),
		totalMinutes: flexed.projectedMinutes,
		overByMinutes: flexed.deltaMinutes,
		rows: ordered.map((row) => {
			const clocked = byBeat.get(row.id);
			return {
				rowId: row.id,
				kind: row.kind,
				label: row.label,
				detail: row.detail,
				minutes: row.minutes,
				start: clocked?.start ?? null,
				scheduledMinutes: clocked?.minutes ?? 0,
				flex: row.flex
					? { minMinutes: TABLE_TOPICS_MIN, maxMinutes: TABLE_TOPICS_MAX }
					: null,
				repeats:
					row.repeatsRoleKey == null
						? null
						: { roleKey: row.repeatsRoleKey, times: clocked?.iterations ?? 0 },
			};
		}),
	};
}

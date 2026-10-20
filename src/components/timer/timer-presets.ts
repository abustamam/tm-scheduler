// src/components/timer/timer-presets.ts
//
// The public `/timer` page's presets and mark validation (#1248). Pure: no
// React, nothing from `#/server` or `#/db`.
//
// Marks are held as `m:ss` TEXT while being edited and become `TimingMarks`
// (float minutes, the unit `timerSignal` reads) only once they validate. The
// disqualification point is NOT a setting here: it is `timerSignal(..., "speech")`
// reading red + `TIMING_GRACE_MINUTES`, and `disqualifiedAfter` below only
// PRINTS that same number.
import type { TimingMarks } from "#/lib/agenda-runsheet";
import { formatElapsedSeconds, parseStopwatch } from "#/lib/timer-state";
import { TIMING_GRACE_MINUTES } from "#/lib/timing-window";

export type PresetId = "ice-breaker" | "speech" | "table-topics" | "evaluation";
export type Selection = PresetId | "custom";

export type MarkFields = { green: string; yellow: string; red: string };

export const PRESETS: readonly {
	id: PresetId;
	label: string;
	marks: TimingMarks;
}[] = [
	{ id: "ice-breaker", label: "Ice Breaker", marks: mk(4, 5, 6) },
	{ id: "speech", label: "Speech", marks: mk(5, 6, 7) },
	{ id: "table-topics", label: "Table Topics", marks: mk(1, 1.5, 2) },
	{ id: "evaluation", label: "Evaluation", marks: mk(2, 2.5, 3) },
];

function mk(green: number, yellow: number, red: number): TimingMarks {
	return { green, yellow, red };
}

/** Float minutes → the `m:ss` a field shows. */
export function minutesToField(minutes: number): string {
	return formatElapsedSeconds(Math.round(minutes * 60));
}

export function fieldsForMarks(marks: TimingMarks): MarkFields {
	return {
		green: minutesToField(marks.green),
		yellow: minutesToField(marks.yellow),
		red: minutesToField(marks.red),
	};
}

export function presetById(id: PresetId) {
	const preset = PRESETS.find((p) => p.id === id);
	if (!preset) throw new Error(`unknown preset ${id}`);
	return preset;
}

export type MarksResult =
	| { ok: true; marks: TimingMarks }
	| { ok: false; message: string };

/** 0 < green < yellow < red, each typed as `m:ss`. */
export function validateMarks(fields: MarkFields): MarksResult {
	const g = parseStopwatch(fields.green);
	const y = parseStopwatch(fields.yellow);
	const r = parseStopwatch(fields.red);
	if (g === null || y === null || r === null) {
		return {
			ok: false,
			message: "Enter each mark as minutes and seconds, like 5:00.",
		};
	}
	if (g <= 0) return { ok: false, message: "Green must be after 0:00." };
	if (!(g < y && y < r)) {
		return {
			ok: false,
			message: "Marks must run green, then yellow, then red, each later.",
		};
	}
	return { ok: true, marks: { green: g / 60, yellow: y / 60, red: r / 60 } };
}

/** "6:30" for a red of 6:00. The same instant `timerSignal` flips to `over`. */
export function disqualifiedAfter(marks: TimingMarks): string {
	return minutesToField(marks.red + TIMING_GRACE_MINUTES);
}

const STORAGE_KEY = "gavelup:timer";

export type Remembered = {
	selection: Selection;
	fields: MarkFields;
	showClock: boolean;
};

/** Best-effort: storage can be absent, blocked or full, and the page must work
 *  without it. Anything malformed reads as "nothing remembered". */
export function loadRemembered(): Remembered | null {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const v = JSON.parse(raw) as Partial<Remembered>;
		const f = v.fields;
		const okSel =
			v.selection === "custom" || PRESETS.some((p) => p.id === v.selection);
		if (
			!okSel ||
			!f ||
			typeof f.green !== "string" ||
			typeof f.yellow !== "string" ||
			typeof f.red !== "string" ||
			typeof v.showClock !== "boolean"
		) {
			return null;
		}
		return {
			selection: v.selection as Selection,
			fields: { green: f.green, yellow: f.yellow, red: f.red },
			showClock: v.showClock,
		};
	} catch {
		return null;
	}
}

export function saveRemembered(value: Remembered): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Not remembering is the whole cost.
	}
}

// src/lib/agenda-timing.ts
import type { AgendaRow } from "./agenda-runsheet";

/** An agenda row with its running-clock start time. */
export type TimelineRow = AgendaRow & { time: string };

/** Wall-clock minutes-since-midnight of `date` in `timeZone`. */
function startMinutesInZone(date: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZone,
	}).formatToParts(date);
	const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
	const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
	// Intl can emit "24" for midnight in hour12:false; normalize to 0.
	return (hour % 24) * 60 + minute;
}

/** Total minutes-since-midnight → "6:45" (12-hour, no am/pm, matching the print design). */
function formatClock(totalMinutes: number): string {
	const h24 = Math.floor(totalMinutes / 60) % 24;
	const m = totalMinutes % 60;
	// Bias by 11 so that 0 (midnight) and 12 (noon) both land on 12 in mod-12 space.
	const h12 = ((h24 + 11) % 12) + 1;
	return `${h12}:${String(m).padStart(2, "0")}`;
}

/**
 * Attach a running-clock `time` to each row. Row n starts at the meeting start
 * plus the sum of all prior rows' durations, formatted in the club timezone.
 */
export function buildTimeline(
	rows: AgendaRow[],
	startsAt: Date | string,
	timeZone: string,
): TimelineRow[] {
	const start = typeof startsAt === "string" ? new Date(startsAt) : startsAt;
	let cursor = startMinutesInZone(start, timeZone);
	return rows.map((r) => {
		const time = formatClock(cursor);
		cursor += r.minutes;
		return { ...r, time };
	});
}

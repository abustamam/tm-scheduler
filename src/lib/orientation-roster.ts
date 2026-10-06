/**
 * "New members in orientation" (#942): the VPE dashboard's view of everyone
 * currently working through the #940 checklist. The pure half, db-free so the
 * dashboard route can read the threshold and the labels without reaching
 * `#/db`; the loader is `loadOrientationRoster` in `reporting-logic.ts`.
 *
 * ## Who is listed
 *
 * Every ACTIVE member whose checklist is VISIBLE by `orientationView`
 * (`#/lib/orientation`): started, not dismissed, not complete. That predicate
 * is #940's, not restated here, so the member's own dashboard and this list
 * cannot disagree about who is in orientation.
 *
 * ## "Stalled"
 *
 * There is deliberately no stalled RULE and no setting (maintainer, 2026-09-25):
 * nobody is filtered out or flagged by anything but time. A member is
 * **stalled** when they have been in orientation for MORE than
 * `ORIENTATION_STALLED_AFTER_DAYS` whole days (so day 28 is not stalled and day
 * 29 is), counting from `orientation_started_at`. The row is highlighted, and
 * that is all the word does.
 */
import type { OrientationItem, OrientationItemKey } from "#/lib/orientation";
import type { ContactMethod } from "#/lib/preferred-contact";

/** Past this many whole days in orientation, the row is highlighted. */
export const ORIENTATION_STALLED_AFTER_DAYS = 28;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days since orientation started: elapsed 24-hour periods, floored, and
 * never negative (a clock skew between the row's writer and `now` must not
 * print "Day -1").
 */
export function daysInOrientation(startedAt: Date, now: Date): number {
	return Math.max(
		0,
		Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS),
	);
}

/** More than `ORIENTATION_STALLED_AFTER_DAYS` whole days. */
export function isStalledInOrientation(days: number): boolean {
	return days > ORIENTATION_STALLED_AFTER_DAYS;
}

/** The compact tick labels the row shows, per checklist item. */
export const ORIENTATION_TICK_LABELS: Record<OrientationItemKey, string> = {
	"choose-path": "path",
	"ice-breaker": "Ice Breaker",
	"supporting-role": "supporting role",
	"base-camp": "Base Camp",
	"get-a-mentor": "mentor",
};

/**
 * One checklist item as the roster row and the orientation nudge read it: which
 * item, and whether it is done. The label is `ORIENTATION_TICK_LABELS`'.
 */
export type OrientationTick = Pick<OrientationItem, "key" | "done">;

/** One member in orientation, as the dashboard receives it. */
export interface OrientationRosterRow {
	memberId: string;
	name: string;
	preferredName: string | null;
	/** Blank is null: the nudge draft must not address "". */
	email: string | null;
	/** E.164, or null. */
	phone: string | null;
	/** The EFFECTIVE preferred contact (#1093). */
	preferredContact?: ContactMethod | null;
	startedAt: Date;
	/** `daysInOrientation(startedAt, now)`, computed once on the server. */
	days: number;
	/** `orientationView(facts).items`, in checklist order, key and done only. */
	items: OrientationTick[];
	/**
	 * Active new-member mentors (`orientationView(facts).mentors`): the SAME
	 * pairings that tick the "mentor" item, so the column and the tick agree.
	 */
	mentorNames: string[];
}

/** Longest in orientation first; ties by name, so the order is stable. */
export function compareOrientationRows(
	a: Pick<OrientationRosterRow, "startedAt" | "name">,
	b: Pick<OrientationRosterRow, "startedAt" | "name">,
): number {
	const byStart = a.startedAt.getTime() - b.startedAt.getTime();
	if (byStart !== 0) return byStart;
	return a.name.localeCompare(b.name);
}

/** "Started today", else "Day N". */
export function orientationDayLabel(days: number): string {
	return days === 0 ? "Started today" : `Day ${days}`;
}

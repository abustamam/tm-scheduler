/**
 * Pure, db-free adapter from a persisted `club_meeting_recurrence` rule (#190)
 * to the one-off `RecurrenceInput` shape (#184) used by `generateOccurrences`.
 *
 * A standing rule is OPEN-ENDED — it has no `count`/`until` bound. Top-up
 * generates a window of upcoming occurrences and the caller inserts only the
 * ones needed to reach `keep_ahead`. Generation starts on/after `notBefore`
 * (the club-local "today"), and for interval mode it preserves the fortnightly
 * (every-N-weeks) PHASE anchored at `anchorDate` — starting from `anchorDate`
 * directly would waste the 52-cap on long-past occurrences once a rule has
 * lived for a while.
 */

import {
	MAX_BATCH,
	type Ordinal,
	type RecurrenceInput,
	type Weekday,
} from "./meeting-recurrence";

/** The subset of a stored recurrence row needed to generate occurrences. */
export interface StoredRecurrenceRule {
	mode: "interval" | "monthly";
	weekday: number;
	/** interval mode only. */
	intervalWeeks: number | null;
	/** interval mode only — YYYY-MM-DD phase anchor (club-local). */
	anchorDate: string | null;
	/** monthly mode only — subset of {"1".."5","last"}. */
	ordinals: string[] | null;
	timeOfDay: string;
	keepAhead: number;
	location: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

function parseYmd(s: string): Date {
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) throw new Error("Invalid date.");
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fmtYmd(dt: Date): string {
	return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function addDays(dt: Date, n: number): Date {
	return new Date(dt.getTime() + n * 86_400_000);
}

/** Parse a stored ordinal token into the `Ordinal` union. */
function parseOrdinal(s: string): Ordinal {
	if (s === "last") return "last";
	const n = Number(s);
	if (n >= 1 && n <= 5) return n as Ordinal;
	throw new Error(`Invalid ordinal: ${s}`);
}

/**
 * The first on-phase interval occurrence on/after `notBefore`, preserving the
 * every-`intervalWeeks`-weeks cadence anchored at `anchorDate`. Returns a
 * YYYY-MM-DD that lands on `weekday` (so `generateOccurrences` starts exactly
 * there with no re-anchoring).
 */
function onPhaseStart(
	anchorDate: string,
	weekday: Weekday,
	intervalWeeks: number,
	notBefore: string,
): string {
	const anchor = parseYmd(anchorDate);
	// phase0: first `weekday` on/after the anchor — matches how
	// `generateOccurrences` seeds an interval series from its startDate.
	const phase0 = addDays(anchor, (weekday - anchor.getUTCDay() + 7) % 7);
	const stepDays = Math.max(1, Math.floor(intervalWeeks)) * 7;
	const nb = parseYmd(notBefore);
	const deltaSteps =
		(nb.getTime() - phase0.getTime()) / (stepDays * 86_400_000);
	const k = Math.max(0, Math.ceil(deltaSteps));
	return fmtYmd(addDays(phase0, k * stepDays));
}

/**
 * Build a `RecurrenceInput` that yields a window of future occurrences for the
 * standing rule, beginning on/after `notBefore` (YYYY-MM-DD, club-local). The
 * bound is always `count: MAX_BATCH`; the caller trims to `keep_ahead`.
 */
export function buildTopUpRecurrenceInput(
	rule: StoredRecurrenceRule,
	notBefore: string,
): RecurrenceInput {
	const weekday = rule.weekday as Weekday;
	const bound = { kind: "count", count: MAX_BATCH } as const;

	if (rule.mode === "monthly") {
		if (!rule.ordinals || rule.ordinals.length === 0) {
			throw new Error("Monthly rule requires ordinals.");
		}
		return {
			mode: "monthly",
			weekday,
			ordinals: rule.ordinals.map(parseOrdinal),
			timeOfDay: rule.timeOfDay,
			startDate: notBefore,
			bound,
		};
	}

	if (rule.intervalWeeks == null || !rule.anchorDate) {
		throw new Error("Interval rule requires intervalWeeks and anchorDate.");
	}
	return {
		mode: "interval",
		weekday,
		intervalWeeks: rule.intervalWeeks,
		timeOfDay: rule.timeOfDay,
		startDate: onPhaseStart(
			rule.anchorDate,
			weekday,
			rule.intervalWeeks,
			notBefore,
		),
		bound,
	};
}

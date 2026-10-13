/**
 * The speech-request queue's pure parts (#1052, epic #1054): the input contract,
 * the preferred-date rules and the VPE queue's order.
 *
 * A request is what a member typed ("I would like to give this speech, on one of
 * these dates"). It is not a speech: scheduling it copies it into a Person-owned
 * `speeches` row and a speaker slot (`speech-requests-logic.ts`).
 *
 * Lives in `lib/` rather than beside the writer so the numbers and the ordering
 * are testable without a database and importable from a client route.
 */
import { z } from "zod";
import { utcToZonedWallTime } from "#/lib/datetime";
import { SPEAKER_FIELDS, SPEAKER_LIMITS } from "#/lib/speaker-limits";

/** A request names at most three dates (`speech_requests_max_three_dates`). */
export const MAX_PREFERRED_DATES = 3;

/** Shown wherever a request has no title (Easy-Speak lets a member ask without one). */
export const UNTITLED_REQUEST_LABEL = "Untitled";

/** Shown on /me for a request whose scheduled slot was released, moved or cancelled (#1052). */
export const BACK_IN_QUEUE_NOTICE =
	"Your scheduled slot is no longer yours (released, reassigned or cancelled): you're back in the queue.";

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written `YYYY-MM-DD` (rejects `2026-02-31`). */
export function isCalendarDay(value: string): boolean {
	if (!CALENDAR_DAY.test(value)) return false;
	const [y, m, d] = value.split("-").map(Number) as [number, number, number];
	const parsed = new Date(Date.UTC(y, m - 1, d));
	return (
		parsed.getUTCFullYear() === y &&
		parsed.getUTCMonth() === m - 1 &&
		parsed.getUTCDate() === d
	);
}

/**
 * The dates a request keeps: real days only, each once, in the order given,
 * capped at three. Used on the import, where the source's list is not trusted;
 * the member's form is validated strictly by {@link preferredDatesField}.
 */
export function normalizePreferredDates(
	dates: ReadonlyArray<string | null | undefined>,
): string[] {
	const out: string[] = [];
	for (const date of dates) {
		if (!date || !isCalendarDay(date) || out.includes(date)) continue;
		out.push(date);
		if (out.length === MAX_PREFERRED_DATES) break;
	}
	return out;
}

/** The member's dates, as a form submits them: at most three, each a real, distinct day. */
export const preferredDatesField = z
	.array(
		z
			.string()
			.refine(isCalendarDay, "Pick each preferred date from the calendar."),
	)
	.max(
		MAX_PREFERRED_DATES,
		`Name at most ${MAX_PREFERRED_DATES} preferred dates.`,
	)
	.refine((dates) => new Set(dates).size === dates.length, {
		message: "Each preferred date can be named once.",
	});

/** A blank field is "not given": the column is NULL, never the empty string. */
const optionalText = (schema: z.ZodString) =>
	schema
		.optional()
		.nullable()
		.transform((v) => {
			const trimmed = v?.trim();
			return trimmed ? trimmed : null;
		});

/** The fields a member types, shared by create and edit. */
export const speechRequestFieldsSchema = z.object({
	title: optionalText(SPEAKER_FIELDS.speechTitle),
	path: optionalText(SPEAKER_FIELDS.pathwayPath),
	projectName: optionalText(SPEAKER_FIELDS.projectName),
	introduction: optionalText(SPEAKER_FIELDS.introduction),
	preferredDates: preferredDatesField.default([]),
});

export type SpeechRequestFields = z.output<typeof speechRequestFieldsSchema>;

/** Caps for text arriving from a bundle: cut, not refused, so one long cell does not drop the request. */
export function clipImportedText(
	value: string | null | undefined,
	field: "title" | "path" | "projectName" | "introduction",
): string | null {
	const max = {
		title: SPEAKER_LIMITS.speechTitle,
		path: SPEAKER_LIMITS.pathwayPath,
		projectName: SPEAKER_LIMITS.projectName,
		introduction: SPEAKER_LIMITS.introduction,
	}[field];
	const trimmed = value?.trim();
	return trimmed ? trimmed.slice(0, max) : null;
}

/** What the queue needs of a request to order it. */
export interface QueueOrderable {
	/** When the requester last gave a speech, or null for never. */
	lastSpokeAt: Date | string | null;
	createdAt: Date | string;
}

const at = (value: Date | string) => new Date(value).getTime();

/**
 * Easy-Speak's two orders, composed: the member who has waited longest since
 * their last speech first (never spoken before anyone who has), then the oldest
 * request. Stable for ties past that, so a re-sort never reshuffles equals.
 */
export function sortSpeechQueue<T extends QueueOrderable>(rows: T[]): T[] {
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => {
			const aLast = a.row.lastSpokeAt === null ? null : at(a.row.lastSpokeAt);
			const bLast = b.row.lastSpokeAt === null ? null : at(b.row.lastSpokeAt);
			if (aLast !== bLast) {
				if (aLast === null) return -1;
				if (bLast === null) return 1;
				return aLast - bLast;
			}
			const byRequest = at(a.row.createdAt) - at(b.row.createdAt);
			return byRequest !== 0 ? byRequest : a.index - b.index;
		})
		.map(({ row }) => row);
}

/** The club-local calendar day (`YYYY-MM-DD`) a meeting instant falls on. */
export function clubDayOf(instant: Date | string, timeZone: string): string {
	return utcToZonedWallTime(new Date(instant), timeZone).slice(0, 10);
}

/** True when a meeting at `instant` is on one of the request's preferred days, in the club's zone. */
export function isPreferredDay(
	instant: Date | string,
	timeZone: string,
	preferredDates: readonly string[],
): boolean {
	return preferredDates.includes(clubDayOf(instant, timeZone));
}

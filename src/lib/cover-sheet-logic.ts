/**
 * The pure half of the cover sheet (#1439): when an own release goes through
 * the sheet, and the words and draft it shows. No server imports, so the
 * agenda component and vitest reach it without `DATABASE_URL`.
 */
import { buildCoverAsk, coverLink, isLateDrop } from "#/lib/cover";

/** One role the sheet can hand off. `urlKey` + `clubSlug` build the link the
 *  asked person opens; `meetingId` is the uuid `loadCoverCandidates` wants. */
export interface CoverSlot {
	slotId: string;
	meetingId: string;
	roleLabel: string;
	scheduledAt: string | Date;
	clubSlug: string;
	urlKey: string;
}

/**
 * True when an own release of this meeting's role goes through the sheet:
 * the viewer's OWN row, less than 48h out. An officer releasing someone else's
 * row, and any release further out, keep today's immediate release (#1439).
 */
export function opensCoverSheet(args: {
	isOwnRole: boolean;
	scheduledAt: string | Date;
	now?: Date;
}): boolean {
	return (
		args.isOwnRole &&
		isLateDrop(new Date(args.scheduledAt), args.now ?? new Date())
	);
}

function dayKey(d: Date, timeZone?: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(d);
}

/** "today", "tomorrow", or the weekday ("Wednesday"). */
export function meetingDayWord(
	scheduledAt: Date,
	now: Date,
	timeZone?: string,
): string {
	const day = dayKey(scheduledAt, timeZone);
	if (day === dayKey(now, timeZone)) return "today";
	if (day === dayKey(new Date(now.getTime() + 86_400_000), timeZone)) {
		return "tomorrow";
	}
	return weekdayOf(scheduledAt, timeZone);
}

function weekdayOf(d: Date, timeZone?: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "long",
	}).format(d);
}

/** The draft for one person: `buildCoverAsk` has no name, so the first name
 *  replaces its leading "Hi!". No name leaves the generic draft. */
export function coverDraft(args: {
	slot: CoverSlot;
	origin: string;
	timeZone?: string;
	firstName?: string | null;
}): string {
	const text = buildCoverAsk({
		role: args.slot.roleLabel,
		weekday: weekdayOf(new Date(args.slot.scheduledAt), args.timeZone),
		link: coverLink(
			args.origin,
			args.slot.clubSlug,
			args.slot.urlKey,
			args.slot.slotId,
		),
	});
	return args.firstName ? text.replace(/^Hi!/, `Hi ${args.firstName}!`) : text;
}

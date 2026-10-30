/**
 * Cover requests (#1438): the pure half. A member who hands off their own role
 * leaves a `slot_cover_requests` row; everything a surface needs to say about
 * it that is not a database read lives here, so vitest can reach it without
 * `DATABASE_URL`.
 *
 * The app suggests and drafts; the member sends (CONTEXT.md, "Cover request").
 */
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";

/** A drop this close to the meeting is a LATE drop: there is little time to
 *  line up a replacement quietly, so the decline paths record it. */
export const LATE_DROP_HOURS = 48;

/** Local hour on the meeting day at which an unanswered "finding cover" turns
 *  into "dropped". */
export const COVER_FLIP_HOUR = 6;

export type CoverKind = "finding_cover" | "dropped";
export type CoverStatus = "finding_cover" | "dropped" | "covered";

/** True when the meeting is still ahead and starts within
 *  {@link LATE_DROP_HOURS} of `now`. A meeting already under way is not a late
 *  drop: nobody can be asked to cover it. */
export function isLateDrop(scheduledAt: Date, now: Date): boolean {
	const ms = scheduledAt.getTime() - now.getTime();
	return ms > 0 && ms <= LATE_DROP_HOURS * 3_600_000;
}

/**
 * Where a request stands. `finding_cover` turns into `dropped` at 06:00 in the
 * club's time zone on the meeting day (never later than the meeting itself, so
 * a very early meeting flips at its start). DERIVED, never written: a stored
 * flip would need a job, and the clock is the only input.
 */
export function coverStatus(
	request: { kind: CoverKind; coveredAt: Date | null },
	meeting: { scheduledAt: Date },
	clubTimeZone: string,
	now: Date,
): CoverStatus {
	if (request.coveredAt) return "covered";
	if (request.kind === "dropped") return "dropped";
	const day = utcToZonedWallTime(meeting.scheduledAt, clubTimeZone).slice(
		0,
		10,
	);
	const flipAt = Math.min(
		zonedWallTimeToUtc(
			`${day}T${String(COVER_FLIP_HOUR).padStart(2, "0")}:00`,
			clubTimeZone,
		).getTime(),
		meeting.scheduledAt.getTime(),
	);
	return now.getTime() >= flipAt ? "dropped" : "finding_cover";
}

/** "17 min", "3 h" or "next day". */
function elapsedPhrase(from: Date, to: Date): string {
	const minutes = Math.max(
		1,
		Math.round((to.getTime() - from.getTime()) / 60_000),
	);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h`;
	return "next day";
}

/** "Timer: Sam → Priya · covered in 17 min". */
export function coveredStory(args: {
	roleLabel: string;
	releasedName: string;
	coveredName: string;
	releasedAt: Date;
	coveredAt: Date;
}): string {
	const took = elapsedPhrase(args.releasedAt, args.coveredAt);
	const when = took === "next day" ? "next day" : `in ${took}`;
	return `${args.roleLabel}: ${args.releasedName} → ${args.coveredName} · covered ${when}`;
}

/** The meeting page, opened on the role that needs cover. */
export function coverLink(
	origin: string,
	slug: string,
	urlKey: string,
	slotId: string,
): string {
	const base = origin.replace(/\/+$/, "");
	return `${base}/club/${encodeURIComponent(slug)}/meeting/${encodeURIComponent(urlKey)}?cover=${encodeURIComponent(slotId)}`;
}

/** The message a member sends one person: asks them, by name of the day. */
export function buildCoverAsk(args: {
	role: string;
	weekday: string;
	link: string;
}): string {
	return `Hi! I can't make ${args.weekday}'s meeting and I'm looking for someone to take over my role as ${args.role}. Could you? Grab it here: ${args.link}`;
}

/** The message a member posts to the group: a call for whoever can. */
export function buildCoverCall(args: {
	role: string;
	when: string;
	link: string;
}): string {
	return `Role open for ${args.when}: ${args.role}. First to take it gets it. ${args.link}`;
}

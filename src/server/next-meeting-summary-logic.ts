// src/server/next-meeting-summary-logic.ts
//
// The next meeting after a given one, summarised for the projected deck's
// "What's on tap for next meeting" slide (#932).
//
// Called from `loadMeetingDetail`, which is where the Thank-You slide's
// `nextMeetingAt` has always come from — this replaces that one-column lookup
// with the summary, so the two slides read one query and cannot name different
// meetings. A module of its own because `loadMeetingDetail` is module-private
// inside a `createServerFn` module, which no test can reach; this one can.
//
// It carries NO archive or club gate of its own. `loadMeetingDetail`'s public
// callers resolve the meeting through `resolvePublicMeetingKey` (the archive
// gate for every public meeting reader) before it gets here, and the summary is
// only ever the next meeting of the SAME club.
//
// Cost, since every meeting-detail load now pays it: the next-meeting read that
// was already there (three more columns), plus a same-day count and the next
// meeting's slots, the last two in parallel. The meeting number is the next
// meeting's stored one, else resolved by the shared rule (one club read).
import { and, asc, eq, gte, ne } from "drizzle-orm";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import {
	type NextMeetingSummary,
	summarizeRoles,
} from "#/lib/next-meeting-summary";
import { resolveMeetingNumber } from "./meeting-number-logic";
import { loadMeetingSlots } from "./meeting-slots-logic";
import { resolveMeetingUrlKey } from "./meeting-url-key-logic";

/** The summary as the server builds it: `scheduledAt` is still a `Date`. */
export type LoadedNextMeeting = NextMeetingSummary & { scheduledAt: Date };

/**
 * The club's next non-cancelled meeting strictly after `current`, or null.
 *
 * "Next" is relative to the PRESENTED meeting, not to wall-clock now (the spec
 * the Thank-You slide was built to). `(club_id, scheduled_at)` is unique, so
 * `>=` plus `id <>` is strictly later.
 *
 * The next meeting's number is its stored one, else the shared rule
 * (`resolveMeetingNumber`): a back-dated, unnumbered next meeting has none
 * (#1639), which `current + 1` would have invented.
 *
 * Names only: the slot rows carry no contact (`loadMeetingSlots` selects none),
 * and this projects them down to role labels and display names.
 */
export async function loadNextMeetingSummary(
	current: { id: string; clubId: string; scheduledAt: Date },
	timezone: string,
): Promise<LoadedNextMeeting | null> {
	const [next] = await db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			location: meetings.location,
			theme: meetings.theme,
			meetingNumber: meetings.meetingNumber,
		})
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, current.clubId),
				gte(meetings.scheduledAt, current.scheduledAt),
				ne(meetings.id, current.id),
				ne(meetings.status, "cancelled"),
			),
		)
		.orderBy(asc(meetings.scheduledAt))
		.limit(1);
	if (!next) return null;

	// The next meeting's canonical URL key — through the same resolver
	// `loadMeetingDetail` uses for the current one, so the QR carries -HHmm on a
	// double-header exactly when that meeting's own page link does.
	const [urlKey, slots] = await Promise.all([
		resolveMeetingUrlKey(current.clubId, next.scheduledAt, timezone),
		loadMeetingSlots(next.id),
	]);

	return {
		scheduledAt: next.scheduledAt,
		// Raw: `nextMeetingSlide` owns the display trim.
		location: next.location,
		theme: next.theme,
		meetingNumber: next.meetingNumber ?? (await resolveMeetingNumber(next.id)),
		urlKey,
		...summarizeRoles(slots),
	};
}
